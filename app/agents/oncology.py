"""Cancer-generic vocabulary, so the pipeline works for any cancer patient (not one record set).

Used to: pick oncology-relevant documents, put cancer events on the timeline, and spot cancer
medicines mentioned in notes but missing from the current medicine list."""
from __future__ import annotations

import re

# diagnoses (Synthea + common clinical wording)
CANCER_DX = re.compile(
    r"malignant neoplasm|carcinoma|adenocarcinoma|cancer|lymphoma|leukemia|leukaemia|melanoma|myeloma|sarcoma|"
    r"glioma|glioblastoma|neoplasm of|metasta|tumou?r\b|oncolog", re.I)

# cancer treatment / work-up events worth a timeline entry
CANCER_EVENTS = re.compile(
    r"lumpectomy|mastectomy|colectomy|lobectomy|prostatectomy|resection|excision|biopsy|"
    r"radiation|radiotherapy|brachytherapy|chemotherapy|immunotherapy|infusion|"
    r"mammogra|ct scan|computed tomography|mri|magnetic resonance|pet|bone scan|colonoscopy|"
    r"bronchoscopy|patholog|staging|tumor board|oncology|discussion about (treatment|options)", re.I)

# oncology medicines (generic names). A match on the current list -> "cannot confirm" unless
# the drug dataset covers it, because interactions for these need specialist checking.
ONCOLOGY_DRUGS = [
    "tamoxifen", "letrozole", "anastrozole", "exemestane", "fulvestrant", "ribociclib", "palbociclib",
    "abemaciclib", "trastuzumab", "pertuzumab", "capecitabine", "cyclophosphamide", "doxorubicin",
    "epirubicin", "paclitaxel", "docetaxel", "carboplatin", "cisplatin", "oxaliplatin", "fluorouracil",
    "gemcitabine", "pemetrexed", "etoposide", "irinotecan", "vincristine", "methotrexate", "imatinib",
    "erlotinib", "gefitinib", "osimertinib", "pembrolizumab", "nivolumab", "atezolizumab", "bevacizumab",
    "rituximab", "lenalidomide", "bortezomib", "leuprolide", "bicalutamide", "enzalutamide", "abiraterone",
    "olaparib", "temozolomide", "ondansetron", "dexamethasone", "filgrastim", "pegfilgrastim",
]
ONCOLOGY_DRUG_RE = re.compile(r"\b(" + "|".join(ONCOLOGY_DRUGS) + r")\b", re.I)

# plain-language names for common record terms (8th-grade wording); anything not here is kept as written
PLAIN_TERMS = {
    r"malignant neoplasm of breast": "breast cancer",
    r"malignant neoplasm of (the )?(bronchus|lung)": "lung cancer",
    r"malignant neoplasm of (the )?colon": "colon cancer",
    r"malignant neoplasm of (the )?prostate": "prostate cancer",
    r"malignant neoplasm": "cancer",
    r"acute st segment elevation myocardial infarction|myocardial infarction": "heart attack",
    r"ischemic heart disease": "reduced blood flow to the heart (ischemic heart disease)",
    r"chronic kidney disease stage (\d)": r"long-term kidney disease, stage \1",
    r"diabetes mellitus type 2": "type 2 diabetes",
    r"hypertriglyceridemia": "high triglycerides (a type of blood fat)",
    r"metabolic syndrome x": "metabolic syndrome",
    r"essential hypertension|hypertension": "high blood pressure",
    r"osteoporosis": "thin, weak bones (osteoporosis)",
    r"hyperlipidemia": "high cholesterol",
    r"anemia": "low red blood cells (anemia)",
    r"external beam radiation therapy procedure": "radiation treatment",
    r"lumpectomy of breast": "breast lumpectomy (surgery to remove the lump)",
}


def plain(term: str) -> str:
    for pat, rep in PLAIN_TERMS.items():
        if re.search(pat, term, re.I):
            return re.sub(pat, rep, term, flags=re.I)
    return term
