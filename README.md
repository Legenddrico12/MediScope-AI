# MediScope AI

## Evidence-First Multimodal Medical Imaging Copilot

MediScope AI is a hackathon research prototype designed to assist with
medical image review using multimodal AI.

The system accepts medical images such as **X-rays and DICOM studies**,
analyzes the supplied image, identifies possible visual findings,
attempts to localize those findings with bounding boxes, verifies the
visual evidence, assigns confidence, and filters unsupported findings
through an **Evidence Gate** before displaying them to the user.

The system is designed as a **doctor-assistance tool**, not as a
replacement for professional medical interpretation.

### Core principle

> **The AI proposes. Evidence decides. The doctor remains in control.**

---

# 1. What the Project Does

MediScope AI follows an evidence-first workflow:

```text
Medical Image
      ↓
Image Preprocessing
      ↓
AI Finding Detection
      ↓
AI Localization
      ↓
Evidence Verification
      ↓
Evidence Gate
      ↓
Confidence + Uncertainty
      ↓
MediScope Dashboard