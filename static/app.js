const $ = (s) => document.querySelector(s);

const scan = $('#scan');
const drop = $('#dropzone');
const fileName = $('#fileName');
const img = $('#scanImage');
const markers = $('#markers');
const imageStage = $('#imageStage');
const analyze = $('#analyzeBtn');
const emptyView = $('.empty-view');
const viewerBadge = $('#viewerBadge');

let lastResult = null;
let currentImageIndex = 0;


/* =========================================================
   FILE BROWSER
========================================================= */

$('#browseBtn').onclick = (e) => {
  e.preventDefault();
  scan.click();
};

scan.onchange = () => {
  if (scan.files[0]) {
    previewFile(scan.files[0]);
  }
};


/* =========================================================
   DRAG & DROP
========================================================= */

['dragenter', 'dragover'].forEach((eventName) => {
  drop.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.add('drag');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  drop.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('drag');
  });
});

drop.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();

  const files = e.dataTransfer.files;

  if (!files || !files.length) return;

  try {
    scan.files = files;
  } catch (_) {
    // Some browsers don't allow direct FileList assignment.
  }

  previewFile(files[0]);
});


/* =========================================================
   FILE PREVIEW
========================================================= */

function previewFile(file) {

  fileName.textContent = file.name;

  lastResult = null;
  currentImageIndex = 0;

  markers.innerHTML = '';

  if (file.type.startsWith('image/')) {

    const reader = new FileReader();

    reader.onload = (e) => {
      showPreview(e.target.result, 0);
    };

    reader.onerror = () => {
      showEmptyViewer(
        'Unable to preview this image.'
      );
    };

    reader.readAsDataURL(file);

  } else {

    showEmptyViewer(
      'DICOM preview is generated after analysis.'
    );

    $('#studyMeta').textContent =
      `${file.name} · preview generated after analysis`;

    $('#imageCount').textContent = '0 images';
  }
}


/* =========================================================
   EMPTY VIEW
========================================================= */

function showEmptyViewer(
  message = 'Study preview appears here'
) {

  img.hidden = true;
  imageStage.hidden = true;

  markers.innerHTML = '';

  emptyView.style.display = 'flex';

  if (viewerBadge) {
    viewerBadge.hidden = true;
  }

  const text = emptyView.querySelector('span');

  if (text) {
    text.textContent = message;
  }
}


/* =========================================================
   SHOW IMAGE
========================================================= */

function showPreview(
  src,
  index = 0
) {

  currentImageIndex = index;

  /*
    Wait for the browser to finish loading and sizing
    the image before drawing the bounding boxes.
  */

  img.onload = () => {

    requestAnimationFrame(() => {

      requestAnimationFrame(() => {

        renderMarkers(lastResult);

      });

    });

  };

  img.onerror = () => {

    showEmptyViewer(
      'Unable to display study preview.'
    );

  };

  img.src = src;

  img.hidden = false;

  imageStage.hidden = false;

  emptyView.style.display = 'none';

  /*
    VERY IMPORTANT:

    No transform.
    No zoom.
    No image scaling animation.

    The displayed image and marker now use the
    exact same coordinate system.
  */

  img.style.transform = 'none';

  if (viewerBadge) {
    viewerBadge.hidden = !lastResult;
  }

  $('#studyMeta').textContent =
    lastResult
      ? `${lastResult.study?.modality || 'Unknown'} · ${lastResult.study?.body_region || 'region unknown'}`
      : 'Study preview';

  renderMarkers(lastResult);
}


/* =========================================================
   OLD ZOOM BUTTON COMPATIBILITY
========================================================= */

/*
   We keep these elements so your HTML remains compatible,
   but disable their functionality.

   Zooming can shift the image independently from the marker
   layer and cause incorrect visual alignment.
*/

const zoomOut = $('#zoomOut');
const zoomReset = $('#zoomReset');
const zoomIn = $('#zoomIn');

if (zoomOut) {
  zoomOut.onclick = (e) => {
    e.preventDefault();
  };
}

if (zoomReset) {
  zoomReset.onclick = (e) => {
    e.preventDefault();
  };
}

if (zoomIn) {
  zoomIn.onclick = (e) => {
    e.preventDefault();
  };
}


/* =========================================================
   ANALYZE
========================================================= */

analyze.onclick = async () => {

  if (!scan.files[0]) {
    alert('Upload a study first.');
    return;
  }

  analyze.disabled = true;

  const buttonText =
    analyze.querySelector('span');

  if (buttonText) {
    buttonText.textContent =
      'Analyzing evidence…';
  }

  const formData = new FormData();

  formData.append(
    'scan',
    scan.files[0]
  );

  formData.append(
    'notes',
    $('#notes').value
  );

  formData.append(
    'modality',
    $('#modality').value
  );

  try {

    const response = await fetch(
      '/api/analyze',
      {
        method: 'POST',
        body: formData
      }
    );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {

      throw new Error(
        data.error ||
        'Analysis failed'
      );

    }

    lastResult =
      data.result;

    /*
      Display the first image returned by
      the backend.
    */

    if (
      Array.isArray(
        lastResult.preview_images
      ) &&
      lastResult.preview_images.length
    ) {

      showPreview(
        lastResult.preview_images[0],
        0
      );

    }

    render(
      lastResult
    );

    if (viewerBadge) {
      viewerBadge.hidden = false;
    }

  } catch (error) {

    console.error(
      error
    );

    alert(
      error.message ||
      'Analysis failed.'
    );

  } finally {

    analyze.disabled = false;

    if (buttonText) {
      buttonText.textContent =
        'Analyze with MediScope';
    }

  }
};


/* =========================================================
   ESCAPE HTML
========================================================= */

function esc(
  value = ''
) {

  return String(value).replace(
    /[&<>'"]/g,
    (character) => ({

      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'

    })[character]
  );

}


/* =========================================================
   PERCENTAGE
========================================================= */

function pct(
  value
) {

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      100,
      number
    )
  );

}


/* =========================================================
   NORMALIZE BOUNDING BOX
========================================================= */

function normalizeBbox(
  bbox
) {

  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4
  ) {

    return null;

  }

  const values =
    bbox.map(Number);

  if (
    values.some(
      (value) =>
        !Number.isFinite(value)
    )
  ) {

    return null;

  }

  let [
    x1,
    y1,
    x2,
    y2
  ] = values;


  /*
    Backend uses 0-1000 coordinates.
  */

  x1 = Math.max(
    0,
    Math.min(
      1000,
      x1
    )
  );

  y1 = Math.max(
    0,
    Math.min(
      1000,
      y1
    )
  );

  x2 = Math.max(
    0,
    Math.min(
      1000,
      x2
    )
  );

  y2 = Math.max(
    0,
    Math.min(
      1000,
      y2
    )
  );


  if (
    x2 <= x1 ||
    y2 <= y1
  ) {

    return null;

  }

  return [
    x1,
    y1,
    x2,
    y2
  ];

}


/* =========================================================
   RENDER AI MARKERS
========================================================= */

function renderMarkers(
  result
) {

  markers.innerHTML = '';

  if (
    !result ||
    !Array.isArray(
      result.findings
    ) ||
    imageStage.hidden
  ) {

    return;

  }


  result.findings.forEach(
    (
      finding,
      findingIndex
    ) => {

      const location =
        finding?.location || {};


      const imageIndex =
        Number(
          location.image_index
        );


      /*
        Only show findings belonging
        to the image currently displayed.
      */

      if (
        imageIndex !==
        currentImageIndex
      ) {

        return;

      }


      const bbox =
        normalizeBbox(
          location.bbox
        );


      if (!bbox) {
        return;
      }


      const [
        x1,
        y1,
        x2,
        y2
      ] = bbox;


      const marker =
        document.createElement(
          'div'
        );


      marker.className =
        'marker';


      /*
        CRITICAL FIX:

        imageStage contains the actual image.

        Therefore these percentages are relative
        to the displayed image itself.

        0-1000 → 0-100%
      */

      marker.style.left =
        `${x1 / 10}%`;

      marker.style.top =
        `${y1 / 10}%`;

      marker.style.width =
        `${(x2 - x1) / 10}%`;

      marker.style.height =
        `${(y2 - y1) / 10}%`;


      /*
        Finding label
      */

      const tag =
        document.createElement(
          'div'
        );

      tag.className =
        'tag';


      const confidence =
        pct(
          finding.confidence
        );


      tag.textContent =
        `F${findingIndex + 1} · ${confidence}%`;


      marker.appendChild(
        tag
      );


      marker.title =
        finding.title ||
        'AI finding';


      marker.setAttribute(
        'aria-label',
        `${finding.title || 'AI finding'} · ${confidence}% confidence`
      );


      /*
        Clicking a box scrolls to
        the matching finding card.
      */

      marker.onclick = () => {

        const card =
          document.querySelector(
            `.finding[data-i="${findingIndex}"]`
          );

        if (card) {

          card.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
          });


          card.classList.add(
            'finding-highlight'
          );


          setTimeout(
            () => {

              card.classList.remove(
                'finding-highlight'
              );

            },
            1200
          );

        }

      };


      markers.appendChild(
        marker
      );

    }
  );

}


/* =========================================================
   REDRAW WHEN WINDOW RESIZES
========================================================= */

let resizeTimer = null;

window.addEventListener(
  'resize',
  () => {

    clearTimeout(
      resizeTimer
    );

    resizeTimer =
      setTimeout(
        () => {

          renderMarkers(
            lastResult
          );

        },
        80
      );

  }
);


/* =========================================================
   OBSERVE IMAGE STAGE SIZE
========================================================= */

if (
  typeof ResizeObserver !==
  'undefined'
) {

  const observer =
    new ResizeObserver(
      () => {

        renderMarkers(
          lastResult
        );

      }
    );


  if (imageStage) {
    observer.observe(
      imageStage
    );
  }

}


/* =========================================================
   UNCERTAINTY METER
========================================================= */

function meter(
  label,
  value
) {

  const amount =
    pct(value);

  return `

    <div class="meter">

      <label>

        <span>
          ${esc(label)}
        </span>

        <span>
          ${amount}%
        </span>

      </label>


      <div class="bar">

        <i
          style="
            width:${amount}%
          "
        ></i>

      </div>

    </div>

  `;

}


/* =========================================================
   RESULTS
========================================================= */

function render(
  result
) {

  const study =
    result.study ||
    {};


  $('#studyMeta').textContent =
    `${study.modality || 'Unknown'} · ` +
    `${study.body_region || 'region unknown'} · ` +
    `${study.image_quality || 'quality unknown'}`;


  $('#imageCount').textContent =
    `${result.meta?.images_analyzed || 1} image(s) analyzed`;


  renderMarkers(
    result
  );


  const uncertainty =
    result.uncertainty ||
    {};


  const radar = `

    <div class="radar">

      <div class="radar-title">

        <span>
          UNCERTAINTY RADAR
        </span>

        <span>
          ${pct(
            uncertainty.overall
          )}% confidence
        </span>

      </div>


      ${meter(
        'Image quality',
        uncertainty.image_quality
      )}


      ${meter(
        'Localization',
        uncertainty.localization
      )}


      ${meter(
        'Clinical context',
        uncertainty.clinical_context
      )}


      ${meter(
        'Modality',
        uncertainty.modality
      )}


      <p
        style="
          font-size:9px;
          color:#738b93
        "
      >

        ${esc(
          uncertainty.reason ||
          'Confidence is separated into components.'
        )}

      </p>

    </div>

  `;


  const gaps =
    (
      result.evidence_gaps ||
      []
    ).filter(Boolean);


  const gapBox =
    gaps.length
      ? `

        <div class="gapbox">

          <b>
            Evidence gaps
          </b>

          <br>

          ${gaps
            .map(
              (gap) =>
                '• ' +
                esc(gap)
            )
            .join('<br>')}

        </div>

      `
      : '';


  const notes =
    (
      result.note_insights ||
      []
    ).filter(Boolean);


  const noteBox =
    notes.length
      ? `

        <div class="gapbox">

          <b>
            Patient-note context
          </b>

          <br>

          ${notes
            .map(
              (note) => `

                • ${esc(
                  note.statement
                )}

                <span class="confidence">
                  ${pct(
                    note.confidence
                  )}%
                </span>

              `
            )
            .join('<br>')}

        </div>

      `
      : '';


  const findings =
    result.findings ||
    [];


  const cards =
    findings.length
      ? findings
          .map(
            findingCard
          )
          .join('')

      : `

        <div
          class="results-empty"
          style="
            padding:35px 25px
          "
        >

          <div class="shield">
            ✓
          </div>


          <h3>
            No supported visual findings
          </h3>


          <p>
            The Evidence Gate did not allow
            an unsupported image claim through.
          </p>

        </div>

      `;


  const gate =
    result.evidence_gate ||
    {};


  $('#results').innerHTML = `

    <div
      style="
        padding:16px 17px 4px
      "
    >

      <div class="pill">

        EVIDENCE GATE ·
        ${gate.supported || 0}
        SUPPORTED ·
        ${gate.discarded || 0}
        DISCARDED

      </div>


      <p
        style="
          font-size:10px;
          line-height:1.5;
          color:#819aa1
        "
      >

        ${esc(
          result.summary ||
          'Evidence-first review completed.'
        )}

      </p>

    </div>


    ${radar}

    ${gapBox}

    ${noteBox}

    ${cards}


    <div class="review">

      <b>
        Doctor, consider
      </b>

      ${esc(
        result.next_review ||
        'Review the highlighted regions together with the original study and clinical context.'
      )}

    </div>

  `;


  /*
    Render again after the result cards
    are inserted.
  */

  requestAnimationFrame(
    () => {

      renderMarkers(
        result
      );

    }
  );

}


/* =========================================================
   FINDING CARD
========================================================= */

function findingCard(
  finding,
  index
) {

  const evidence =
    (
      finding.evidence ||
      []
    ).find(
      (item) =>
        item.type === 'image'
    );


  const confidence =
    pct(
      finding.confidence
    );


  return `

    <article
      class="finding"
      data-i="${index}"
    >


      <div class="finding-top">

        <h3>

          ${esc(
            finding.title ||
            'Finding'
          )}

        </h3>


        <span class="confidence">

          ${confidence}%

        </span>

      </div>


      <p>

        ${esc(
          finding.description ||
          ''
        )}

      </p>


      <div>

        <span class="pill">

          IMAGE · F${index + 1}

        </span>

        ${esc(
          evidence?.detail ||
          'Localized visual evidence'
        )}

      </div>


      <div class="evidence">

        <b>
          Clinical context:
        </b>

        ${esc(
          finding.clinical_context ||
          'None supplied'
        )}

        <br>


        <b>
          What would change confidence:
        </b>

        ${esc(
          finding.what_changes_confidence ||
          'Additional review of the original study.'
        )}

      </div>


      ${
        finding.localization_reason
          ? `

            <div class="evidence">

              <b>
                Localization check:
              </b>

              ${esc(
                finding.localization_reason
              )}

            </div>

          `
          : ''
      }


      ${
        finding.verification_reason
          ? `

            <div class="evidence">

              <b>
                Evidence verification:
              </b>

              ${esc(
                finding.verification_reason
              )}

            </div>

          `
          : ''
      }

    </article>

  `;

}