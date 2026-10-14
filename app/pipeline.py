"""Orchestration: the request flow from PRD section 8.

safety gate -> Main Agent (care contract) -> [Intake || Classifier] -> [Summarizer || Medication]
-> Manager/Compiler (verify + retry) -> awaiting patient/caregiver review (approve/improve/reject)."""
from __future__ import annotations

import asyncio
import re
import time

from . import safety
from .agents import classifier, compiler, intake, main_agent, medication, summarizer
from .context import RunContext
from .llm import llm
from .schemas import Claim, now


async def run_pipeline(ctx: RunContext) -> None:
    run = ctx.run
    run.mode = "llm" if llm.enabled else "rules"
    t0 = time.perf_counter()
    try:
        # 1. emergency gate - before anything else touches the documents
        ctx.emit("safety", "start", "Checking the request for a current emergency")
        hits = safety.keyword_emergency(run.request)
        model_hit, model_reason = await safety.classifier_emergency(run.request)
        if hits or model_hit:
            run.status = "hard_stop"
            run.hard_stop_message = safety.HARD_STOP_MESSAGE
            why = ", ".join(hits) if hits else f"safety classifier: {model_reason}"
            ctx.emit("safety", "hard_stop", f"HARD STOP ({why}). No summary will be produced.",
                     triggers=hits, classifier=model_reason)
            return
        ctx.emit("safety", "finish", "No current emergency found in the request"
                 + ("" if model_hit is not None else " (keyword rules only; model classifier not configured)"))

        # 2. Main Agent writes the care contract
        ctx.emit("main", "start", "Reading the request and writing the care contract")
        contract = await main_agent.plan(ctx)
        run.contract = contract
        ctx.emit("main", "finish", f"Care contract: {contract.intent.replace('_', ' ')}"
                 + (f" / {contract.specialty}" if contract.specialty else ""), contract=contract.model_dump())

        # 3. Workers in parallel (with the dependency: summarizer needs intake's document choice)
        t = time.perf_counter()
        (index, cls_flags), _ = await asyncio.gather(classifier.run(ctx), intake.run(ctx, contract))
        (facts, timeline, sum_flags, name), (meds, interactions, allergies, med_flags) = await asyncio.gather(
            summarizer.run(ctx, contract), medication.run(ctx))
        run.timings["workers_s"] = round(time.perf_counter() - t, 2)

        fact_originals = [Claim(**c.model_dump()) for c in summarizer.extract_facts(ctx, contract)[0]] \
            if llm.enabled else [Claim(**c.model_dump()) for c in facts]
        hist = safety.history_flags(run.documents) + safety.sensitive_flags(run.documents)
        for f in hist:
            ctx.emit("safety", "flag", f.text if f.level == "amber" else "Sensitive history item found (clinician only)")
        flags = cls_flags + sum_flags + med_flags + hist
        questions = summarizer.draft_questions(ctx, contract, flags, name, interactions)

        # 4. Compiler verifies and assembles
        t = time.perf_counter()
        run.summary = await compiler.run(ctx, facts=facts, fact_originals=fact_originals, timeline=timeline,
                                         questions=questions, meds=meds, interactions=interactions,
                                         allergies=allergies, flags=flags, patient_name=name)
        run.timings["compile_s"] = round(time.perf_counter() - t, 2)
        run.status = "awaiting_review"
        run.chat.append({"role": "assistant", "ts": now(),
                         "text": "Your summary is ready. Nothing is final until you approve it. "
                                 "You can Approve, ask me to Improve something, or Reject it."})
        ctx.emit("compiler", "status", "Waiting for your review: Approve / Improve / Reject")
    except Exception as e:  # keep the run inspectable
        run.status = "error"
        ctx.emit("main", "error", f"Pipeline error: {type(e).__name__}: {e}")
        raise
    finally:
        run.timings["total_s"] = round(time.perf_counter() - t0, 2)
        run.llm_stats = llm.stats.as_dict()
        ctx.save()


async def improve(ctx: RunContext, message: str) -> None:
    """FR-11: route a change request to the right Worker, re-verify, and return to review."""
    run = ctx.run
    if run.status not in ("awaiting_review",) or not run.summary:
        return
    run.chat.append({"role": "user", "ts": now(), "text": message})
    if safety.keyword_emergency(message):
        run.status = "hard_stop"
        run.hard_stop_message = safety.HARD_STOP_MESSAGE
        ctx.emit("safety", "hard_stop", "HARD STOP: emergency language in the change request.")
        ctx.save()
        return
    workers = main_agent.route_change(message)
    ctx.emit("main", "info", f"Change request routed to: {', '.join(workers)}", workers=workers)
    q_section = next(s for s in run.summary.sections if s.key == "questions_for_doctor")
    summary_section = next(s for s in run.summary.sections if s.key == "plain_language_summary")
    reply = []

    if "summarizer" in workers:
        ctx.emit("summarizer", "start", "Applying the change request")
        topic = re.search(r"\b(?:about|regarding)\s+(?:my |her |his |their |the |our )?(.+?)[.?!]*$", message, re.I)
        if re.search(r"question|ask", message, re.I) and topic:
            subject = topic.group(1).strip()
            words = [w for w in re.findall(r"[a-z]{4,}", subject.lower()) if w not in ("history", "about", "with", "that")]
            stems = [w[:6] for w in words]
            # a source line counts only if it mentions EVERY keyword and has real content (not a heading)
            src = [ln for ln in ctx.lines.values() if stems and all(s in ln.text.lower() for s in stems)
                   and len(ln.text.split()) >= 3 and ln.text.lower() != ln.section.lower()]
            # lines inside a matching section (e.g. ALLERGIES) first, then newest documents; skip header rows
            src = [ln for ln in src if ln.section]
            src = sorted(src, key=lambda ln: (any(s in ln.section.lower() for s in stems), ln.doc_id), reverse=True)[:2]
            v = summarizer.Voice(ctx, run.summary.patient_name)
            text = v.q(f"Can we go over my {subject}?", "Can we go over {name}'s " + subject + "?")
            if src:
                text += " The record says: \"" + safety.redact(src[0].text)[:120] + "\"."
                c = Claim(text=text, source_ids=[s.id for s in src], quote=src[0].text, kind="question")
            else:
                c = Claim(text=text, kind="question", origin="user_request",
                          note="Added at your request. The uploaded record has nothing about this topic.")
            ok, why = compiler.verify(c, ctx.lines)
            c.verified = ok
            if ok:
                q_section.items.append(c)
                reply.append(f"Added a question: \"{c.text}\"" + ("" if src else " (nothing about this was found in the record, so it is marked as your own question)"))
            else:
                reply.append(f"I could not add that question safely ({why}).")
        elif re.search(r"simpl|easier|shorter|plain", message, re.I):
            await summarizer.simplify(ctx, summary_section.items, "Make it shorter and simpler.")
            kept = []
            for c in summary_section.items:
                ok, why = compiler.verify(c, ctx.lines)
                if ok:
                    kept.append(c)
            summary_section.items = kept
            reply.append("Rewrote the summary in simpler words." if llm.enabled else
                         "Simpler rewriting needs the AMD-hosted model, which is not connected yet. The summary is unchanged.")
        else:
            reply.append("I noted your request. A clinician or the care team can help with anything not in the record.")
        ctx.emit("summarizer", "finish", "Change applied and re-verified")
    if "medication" in workers:
        ctx.emit("medication", "start", "Re-checking medicines for the change request")
        n = len(run.summary.medications)
        reply.append(f"The medicine checklist has {n} medicines and {sum(i.confirmed for i in run.summary.interactions)} "
                     "possible interactions to confirm with your doctor or pharmacist.")
        ctx.emit("medication", "finish", "Medication checklist re-verified")
    run.chat.append({"role": "assistant", "ts": now(), "text": " ".join(reply) + " Please review again: Approve, Improve or Reject."})
    ctx.emit("compiler", "status", "Updated summary re-verified; waiting for review")
    ctx.save()


def approve(ctx: RunContext) -> None:
    if ctx.run.status != "awaiting_review":
        return
    ctx.run.status = "approved"
    who = ctx.run.submitter
    ctx.run.chat.append({"role": "system", "ts": now(),
                         "text": f"Approved by the {who.role.value}{' (' + who.name + ')' if who.name else ''}. The summary is now final."})
    ctx.emit("compiler", "status", f"Approved by {who.role.value}. Summary is final.")
    ctx.save()


def reject(ctx: RunContext) -> None:
    if ctx.run.status != "awaiting_review":
        return
    ctx.run.status = "rejected"
    ctx.run.chat.append({"role": "system", "ts": now(), "text": "Rejected. This summary is not approved and not final."})
    ctx.emit("compiler", "status", "Rejected. No final summary.")
    ctx.save()
