import os
import io
import json
import base64
import zipfile
from pathlib import Path

from flask import Flask, render_template, request, jsonify
from werkzeug.utils import secure_filename
from dotenv import load_dotenv
from PIL import Image, ImageOps, ImageEnhance
import pydicom
from groq import Groq

load_dotenv()

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 40 * 1024 * 1024

GROQ_API_KEY = os.getenv('GROQ_API_KEY', '').strip()
GROQ_MODEL = os.getenv('GROQ_MODEL', 'qwen/qwen3.8-27b').strip()
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

ANALYSIS_PROMPT = r'''
You are MediScope AI, an evidence-first medical imaging assistant for a
hackathon research prototype. You are NOT a doctor.

Analyze ONLY the supplied medical image(s). Do not diagnose with certainty and
do not recommend treatment. This is a candidate-finding pass; DO NOT create
bounding boxes here.

Rules:
1. Report only observations visibly supported by the supplied image.
2. Do not turn patient notes into visual findings.
3. If the image is non-medical, unreadable, or insufficient, return zero findings.
4. Prefer descriptive observations such as "possible cortical discontinuity"
   rather than definitive diagnoses.
5. Confidence is model confidence from 1-99, never 100.
6. For CT, reason only from supplied slices.
7. Return ONLY valid JSON.

JSON:
{
  "study": {"modality":"X-ray|CT|MRI|Ultrasound|Other|Unknown",
    "body_region":"", "view_or_series":"",
    "image_quality":"good|fair|poor|unreadable", "quality_reason":""},
  "summary":"",
  "findings":[{"title":"", "description":"", "confidence":0,
    "severity":"low|moderate|high|unknown", "image_index":0,
    "visual_evidence":"", "clinical_context":"",
    "what_changes_confidence":""}],
  "note_insights":[], "evidence_gaps":[],
  "uncertainty":{"overall":0,"image_quality":0,"localization":0,
    "clinical_context":0,"modality":0,"reason":""},
  "next_review":""
}
'''

LOCALIZATION_PROMPT = r'''
You are the localization module of MediScope AI.

You receive one medical image and one candidate visual finding. Independently
inspect the image and decide whether the finding is actually visible.

If supported, return a TIGHT box around the smallest useful region containing
the finding. Do NOT box an entire bone, organ, limb, or large surrounding area.
Do not guess a location from the candidate text. If you cannot confidently
localize it, return supported=false.

Coordinates MUST be normalized 0-1000:
[x1,y1,x2,y2], where (x1,y1) is upper-left and (x2,y2) lower-right.
Confidence is 1-99, never 100. Return ONLY JSON.

Supported:
{"supported":true,"bbox":[x1,y1,x2,y2],"confidence":0,
 "evidence":"","localization_reason":""}

Unsupported:
{"supported":false,"bbox":[0,0,0,0],"confidence":1,
 "evidence":"","localization_reason":""}
'''


def image_to_jpeg(img):
    img = img.convert('RGB')
    img.thumbnail((1800, 1800))
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=92, optimize=True)
    return buf.getvalue()


def encode_image(img):
    return 'data:image/jpeg;base64,' + base64.b64encode(image_to_jpeg(img)).decode('utf-8')


def dicom_to_image(raw):
    ds = pydicom.dcmread(io.BytesIO(raw), force=True)
    if not hasattr(ds, 'PixelData'):
        raise ValueError('DICOM has no pixel data.')
    arr = ds.pixel_array.astype('float32')
    arr = arr * float(getattr(ds, 'RescaleSlope', 1)) + float(getattr(ds, 'RescaleIntercept', 0))
    if arr.ndim == 3:
        arr = arr[arr.shape[0] // 2]
    lo, hi = float(arr.min()), float(arr.max())
    if hi <= lo:
        hi = lo + 1
    arr = ((arr - lo) / (hi - lo) * 255).clip(0, 255)
    img = Image.fromarray(arr.astype('uint8'))
    return ImageEnhance.Contrast(ImageOps.autocontrast(img)).enhance(1.12)


def extract_file(file):
    filename = secure_filename(file.filename or 'upload')
    ext = Path(filename).suffix.lower()
    raw = file.read()
    if ext in {'.jpg', '.jpeg', '.png', '.webp'}:
        return [Image.open(io.BytesIO(raw)).convert('RGB')], {'filename': filename, 'type': 'image'}
    if ext in {'.dcm', '.dicom'}:
        return [dicom_to_image(raw)], {'filename': filename, 'type': 'dicom'}
    if ext == '.zip':
        images = []
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            files = [x for x in archive.infolist() if not x.is_dir() and Path(x.filename).suffix.lower() in {'.dcm', '.dicom'}]
            if not files:
                raise ValueError('No DICOM files found in ZIP.')
            indexes = sorted(set([0, len(files) // 2, len(files) - 1]))
            for i in indexes:
                try:
                    with archive.open(files[i]) as f:
                        images.append(dicom_to_image(f.read()))
                except Exception:
                    pass
        if not images:
            raise ValueError('Could not decode DICOM slices.')
        return images, {'filename': filename, 'type': 'dicom_zip', 'slice_count': len(files)}
    raise ValueError('Unsupported file format. Use JPG, PNG, WEBP, DICOM, or DICOM ZIP.')


def parse_json(text):
    text = (text or '').strip()
    if text.startswith('```'):
        lines = text.splitlines()[1:]
        if lines and lines[-1].strip() == '```':
            lines = lines[:-1]
        text = '\n'.join(lines).strip()
        if text.lower().startswith('json'):
            text = text[4:].strip()
    try:
        return json.loads(text)
    except Exception:
        start, end = text.find('{'), text.rfind('}')
        if start >= 0 and end > start:
            return json.loads(text[start:end + 1])
        raise ValueError('AI returned invalid JSON.')


def clamp_confidence(value, default=1):
    try:
        value = int(float(value))
    except Exception:
        value = default
    return max(1, min(99, value))


def valid_bbox(bbox):
    if not isinstance(bbox, list) or len(bbox) != 4:
        return False
    try:
        x1, y1, x2, y2 = map(float, bbox)
    except Exception:
        return False
    return (0 <= x1 < x2 <= 1000 and 0 <= y1 < y2 <= 1000
            and x2 - x1 >= 5 and y2 - y1 >= 5)


def first_pass(images, modality, notes):
    content = [{
        'type': 'text',
        'text': ANALYSIS_PROMPT + f'''\nStudy modality hint: {modality}\n\nPatient notes:\n{notes if notes else '[No patient notes supplied]'}\n\nThere are {len(images)} supplied images. Every finding must use a valid image_index.'''
    }]
    for image in images:
        content.append({'type': 'image_url', 'image_url': {'url': encode_image(image)}})
    completion = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{'role': 'user', 'content': content}],
        temperature=0.0,
        max_completion_tokens=5000,
        response_format={'type': 'json_object'}
    )
    return parse_json(completion.choices[0].message.content)


def localize(image, candidate):
    candidate_text = json.dumps({
        'title': candidate.get('title', ''),
        'description': candidate.get('description', ''),
        'visual_evidence': candidate.get('visual_evidence', '')
    }, ensure_ascii=False)
    content = [
        {'type': 'text', 'text': LOCALIZATION_PROMPT + f'''\nCandidate finding:\n{candidate_text}\n\nInspect the image yourself. Do not trust the text for location.'''
        },
        {'type': 'image_url', 'image_url': {'url': encode_image(image)}}
    ]
    completion = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{'role': 'user', 'content': content}],
        temperature=0.0,
        max_completion_tokens=1200,
        response_format={'type': 'json_object'}
    )
    return parse_json(completion.choices[0].message.content)


def refine_findings(result, images):
    refined, discarded = [], 0
    for candidate in result.get('findings', []) or []:
        try:
            image_index = int(candidate.get('image_index', 0))
        except Exception:
            discarded += 1
            continue
        if not 0 <= image_index < len(images):
            discarded += 1
            continue
        try:
            loc = localize(images[image_index], candidate)
        except Exception:
            discarded += 1
            continue
        bbox = loc.get('bbox')
        if not bool(loc.get('supported')) or not valid_bbox(bbox):
            discarded += 1
            continue
        candidate['confidence'] = min(
            clamp_confidence(candidate.get('confidence', 1)),
            clamp_confidence(loc.get('confidence', 1))
        )
        candidate['location'] = {'image_index': image_index, 'bbox': [round(float(x), 1) for x in bbox]}
        candidate['evidence'] = [{
            'type': 'image',
            'detail': str(loc.get('evidence') or candidate.get('visual_evidence') or 'Visible image evidence supports this finding.').strip()
        }]
        candidate['localization_reason'] = str(loc.get('localization_reason', '')).strip()
        candidate['evidence_status'] = 'SUPPORTED_BY_IMAGE'
        refined.append(candidate)
    result['findings'] = refined
    result['evidence_gate'] = {
        'supported': len(refined),
        'discarded': discarded,
        'status': 'PASSED' if discarded == 0 else 'FILTERED'
    }
    return result


def validate_notes(result, notes):
    valid = []
    for insight in result.get('note_insights', []) or []:
        quote = str((insight.get('evidence') or {}).get('quote', '')).strip()
        if notes and quote and quote in notes:
            insight['confidence'] = clamp_confidence(insight.get('confidence', 1))
            valid.append(insight)
    result['note_insights'] = valid
    return result


@app.route('/')
def home():
    return render_template('index.html')


@app.route('/health')
def health():
    return jsonify({'ok': True, 'provider': 'Groq', 'model': GROQ_MODEL, 'api_key_configured': bool(GROQ_API_KEY)})


@app.route('/api/analyze', methods=['POST'])
def analyze():
    if client is None:
        return jsonify({'error': 'GROQ_API_KEY is missing. Add it to .env.'}), 500
    file = request.files.get('scan')
    notes = request.form.get('notes', '').strip()
    modality = request.form.get('modality', 'Auto')
    if not file:
        return jsonify({'error': 'Upload an image or DICOM study first.'}), 400
    try:
        images, meta = extract_file(file)
        images = images[:3]
        result = first_pass(images, modality, notes)
        result = refine_findings(result, images)
        result = validate_notes(result, notes)
        result['prototype_disclaimer'] = ('Model confidence is not clinical accuracy. '
            'This hackathon prototype is not a substitute for professional medical interpretation.')
        result['meta'] = {
            'model': GROQ_MODEL,
            'filename': meta['filename'],
            'source_type': meta['type'],
            'images_analyzed': len(images),
            'dicom_slice_count': meta.get('slice_count'),
            'localization': 'two-pass visual verification'
        }
        result['preview_images'] = [encode_image(img) for img in images]
        result['patient_notes_provided'] = bool(notes)
        return jsonify({'ok': True, 'result': result})
    except Exception as e:
        app.logger.exception('Analysis failed')
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '5000')), debug=True)



