require('dotenv').config();

const express = require('express');
const multer = require('multer');

const app = express();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});


// ============================================================
// Configuration
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const MEMOS_API_URL =
    process.env.MEMOS_API_URL ||
    'http://memos:5230/api/v1/memos';

const MEMOS_TOKEN = process.env.MEMOS_TOKEN;

const MEMOS_BASE_API =
    MEMOS_API_URL.replace(/\/memos\/?$/, '');


// ============================================================
// Transcription engines
// ============================================================

const TRANSCRIPTION_ENGINE =
    (process.env.TRANSCRIPTION_ENGINE || 'whisper')
        .trim()
        .toLowerCase();

const TRANSCRIPTION_LANGUAGE =
    (process.env.TRANSCRIPTION_LANGUAGE || 'ro')
        .trim()
        .toLowerCase();

const TRANSCRIPTION_ENGINES = {
    whisper: {
        name: 'Whisper',
        url:
            process.env.WHISPER_URL ||
            'http://homelab-hp:8000/v1/audio/transcriptions',
        model:
            process.env.WHISPER_MODEL ||
            'Systran/faster-whisper-large-v3'
    },

    canary: {
        name: 'Canary',
        url:
            process.env.CANARY_URL ||
            'http://homelab-hp:8001/v1/audio/transcriptions',
        model:
            process.env.CANARY_MODEL ||
            'nemo-canary-1b-v2'
    }
};

const transcriptionConfig =
    TRANSCRIPTION_ENGINES[TRANSCRIPTION_ENGINE];

if (!transcriptionConfig) {
    throw new Error(
        `Invalid TRANSCRIPTION_ENGINE="${TRANSCRIPTION_ENGINE}". ` +
        'Allowed values: whisper, canary'
    );
}

if (!MEMOS_TOKEN) {
    throw new Error('MEMOS_TOKEN is not configured.');
}


// ============================================================
// Helpers
// ============================================================

function getTimestampFilename(originalFilename) {
    const now = new Date();

    const extIndex = originalFilename.lastIndexOf('.');

    const ext =
        extIndex !== -1
            ? originalFilename.substring(extIndex)
            : '.m4a';

    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');

    return {
        filename: `${hh}-${min}-${sec}-${ms}${ext}`,
        hh,
        min,
        now
    };
}


async function transcribeAudio(
    fileBuffer,
    filename,
    mimetype
) {
    const formData = new FormData();

    const blob = new Blob(
        [fileBuffer],
        {
            type: mimetype || 'audio/mpeg'
        }
    );

    formData.append(
        'file',
        blob,
        filename
    );

    formData.append(
        'model',
        transcriptionConfig.model
    );

    formData.append(
        'language',
        TRANSCRIPTION_LANGUAGE
    );

    /*
     * Whisper-specific options.
     *
     * Canary exposes the same basic OpenAI-compatible endpoint,
     * but doesn't need Whisper decoding parameters.
     */
    if (TRANSCRIPTION_ENGINE === 'whisper') {
        formData.append('temperature', '0');

        formData.append(
            'prompt',
            'Transcriere în limba română. ' +
            'Folosește corect diacriticele românești: ă, â, î, ș, ț.'
        );
    }

    console.log(
        `[ASR] ${filename} | ` +
        `engine=${TRANSCRIPTION_ENGINE} | ` +
        `model=${transcriptionConfig.model} | ` +
        `language=${TRANSCRIPTION_LANGUAGE}`
    );

    const controller = new AbortController();

    /*
     * 10 minute timeout.
     *
     * i5 gen 7 + large-v3 / Canary poate avea nevoie
     * de timp pentru înregistrări lungi.
     */
    const timeout = setTimeout(
        () => controller.abort(),
        10 * 60 * 1000
    );

    try {
        const response = await fetch(
            transcriptionConfig.url,
            {
                method: 'POST',
                body: formData,
                signal: controller.signal
            }
        );

        if (!response.ok) {
            const errorBody = await response.text();

            throw new Error(
                `${transcriptionConfig.name} failed: ` +
                `${response.status} ${errorBody}`
            );
        }

        const data = await response.json();

        const transcription =
            typeof data.text === 'string'
                ? data.text.trim()
                : '';

        console.log(
            `[ASR] Completed using ${TRANSCRIPTION_ENGINE}. ` +
            `${transcription.length} characters.`
        );

        return transcription;

    } finally {
        clearTimeout(timeout);
    }
}


// ============================================================
// HTTP endpoint
// ============================================================

app.post(
    '/webhook/audio-journal',
    upload.single('file'),

    (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                error: 'No audio file provided.'
            });
        }

        // Optional GPS data from iOS Shortcut
        const lat =
            req.body.lat !== undefined
                ? Number.parseFloat(req.body.lat)
                : null;

        const lon =
            req.body.lon !== undefined
                ? Number.parseFloat(req.body.lon)
                : null;

        const location =
            Number.isFinite(lat) &&
                Number.isFinite(lon)
                ? {
                    placeholder: 'Audio Location',
                    latitude: lat,
                    longitude: lon
                }
                : undefined;

        /*
         * Shortcut-ul primește răspuns imediat.
         * Procesarea continuă asincron.
         */
        res.status(202).json({
            message: 'Audio accepted. Processing.',
            transcriptionEngine: TRANSCRIPTION_ENGINE
        });

        processAudio(
            req.file.buffer,
            req.file.originalname,
            req.file.mimetype,
            location
        ).catch(error => {
            console.error(
                'ERROR: audio processing failed:',
                error
            );
        });
    }
);


// ============================================================
// Main processing pipeline
// ============================================================

async function processAudio(
    fileBuffer,
    originalFilename,
    mimetype,
    location
) {
    try {
        const requestHeaders = {
            Authorization: `Bearer ${MEMOS_TOKEN}`
        };

        const {
            filename: timeBasedFilename,
            hh,
            min,
            now
        } = getTimestampFilename(originalFilename);


        // ====================================================
        // Transcription
        // ====================================================

        const transcription =
            await transcribeAudio(
                fileBuffer,
                timeBasedFilename,
                mimetype
            );

        if (!transcription) {
            console.log(
                '[Audio Journal] Empty transcription. ' +
                'Skipping memo update.'
            );

            return;
        }


        // ====================================================
        // Determine journal day
        //
        // Entries between 00:00 and 02:59 belong to
        // the previous logical journal day.
        // ====================================================

        const logicalDate =
            new Date(
                now.getTime() -
                (3 * 60 * 60 * 1000)
            );

        const days = [
            'Duminică',
            'Luni',
            'Marți',
            'Miercuri',
            'Joi',
            'Vineri',
            'Sâmbătă'
        ];

        const months = [
            'Ianuarie',
            'Februarie',
            'Martie',
            'Aprilie',
            'Mai',
            'Iunie',
            'Iulie',
            'August',
            'Septembrie',
            'Octombrie',
            'Noiembrie',
            'Decembrie'
        ];

        const titleDateStr =
            `${days[logicalDate.getDay()]} ` +
            `${logicalDate.getDate()} ` +
            `${months[logicalDate.getMonth()]} ` +
            `${logicalDate.getFullYear()}`;

        const targetTitle =
            `# ${titleDateStr}`;

        const targetHeader =
            `#jurnal\n${targetTitle}`;

        const newEntry =
            `### [${hh}:${min}]\n${transcription}`;


        // ====================================================
        // Upload original audio to Memos
        // ====================================================

        let attachmentMeta = null;

        try {
            console.log(
                '[Memos] Uploading audio attachment...'
            );

            const base64Content =
                fileBuffer.toString('base64');

            const uploadRes = await fetch(
                `${MEMOS_BASE_API}/attachments`,
                {
                    method: 'POST',

                    headers: {
                        ...requestHeaders,
                        'Content-Type': 'application/json'
                    },

                    body: JSON.stringify({
                        filename: timeBasedFilename,
                        type: mimetype || 'audio/mpeg',
                        content: base64Content
                    })
                }
            );

            if (!uploadRes.ok) {
                const errText =
                    await uploadRes.text();

                throw new Error(
                    `${uploadRes.status} ${errText}`
                );
            }

            const resourceData =
                await uploadRes.json();

            attachmentMeta = {
                name: resourceData.name
            };

            console.log(
                `[Memos] Audio uploaded: ${resourceData.name}`
            );

        } catch (uploadErr) {
            console.error(
                '[Memos] Attachment upload failed. ' +
                'Text will still be saved.',
                uploadErr
            );
        }


        // ====================================================
        // Find today's existing journal memo
        // ====================================================

        console.log(
            `[Memos] Looking for: ${targetTitle}`
        );

        const listRes = await fetch(
            `${MEMOS_API_URL}?pageSize=20`,
            {
                headers: requestHeaders
            }
        );

        if (!listRes.ok) {
            throw new Error(
                `Memos list failed: ${listRes.status}`
            );
        }

        const listData =
            await listRes.json();

        const existingMemo =
            (listData.memos || []).find(
                memo =>
                    memo.content &&
                    memo.content.includes(targetTitle)
            );


        // ====================================================
        // Build create/update payload
        // ====================================================

        let finalContent;
        let finalAttachments = [];
        let finalLocation = location;

        let method = 'POST';
        let targetUrl = MEMOS_API_URL;


        if (existingMemo) {
            finalContent =
                `${existingMemo.content}\n\n${newEntry}`;

            finalAttachments =
                (existingMemo.attachments || [])
                    .map(attachment => ({
                        name: attachment.name
                    }));

            if (attachmentMeta) {
                finalAttachments.push(
                    attachmentMeta
                );
            }

            /*
             * Keep existing location if this recording
             * didn't provide a new one.
             */
            if (
                !finalLocation &&
                existingMemo.location
            ) {
                finalLocation =
                    existingMemo.location;
            }

            method = 'PATCH';

            targetUrl =
                `${MEMOS_BASE_API}/${existingMemo.name}`;

            const updateMask = [
                'content',
                'attachments'
            ];

            if (finalLocation) {
                updateMask.push('location');
            }

            targetUrl +=
                `?updateMask=${updateMask.join(',')}`;

            console.log(
                `[Memos] Appending to ${existingMemo.name}`
            );

        } else {
            finalContent =
                `${targetHeader}\n\n${newEntry}`;

            if (attachmentMeta) {
                finalAttachments.push(
                    attachmentMeta
                );
            }

            console.log(
                '[Memos] Creating new daily journal memo.'
            );
        }


        const payload = {
            content: finalContent,
            attachments: finalAttachments
        };

        if (finalLocation) {
            payload.location =
                finalLocation;
        }


        // ====================================================
        // Create/update memo
        // ====================================================

        const upsertRes = await fetch(
            targetUrl,
            {
                method,

                headers: {
                    ...requestHeaders,
                    'Content-Type': 'application/json'
                },

                body: JSON.stringify(payload)
            }
        );

        if (!upsertRes.ok) {
            const errorBody =
                await upsertRes.text();

            throw new Error(
                `Memos ${method} failed: ` +
                `${upsertRes.status} ${errorBody}`
            );
        }

        console.log(
            `[Audio Journal] Saved successfully ` +
            `(engine=${TRANSCRIPTION_ENGINE}).`
        );
    } catch (err) {
        console.error(
            'ERROR: Failed to process audio journal entry.',
            err
        );
    }
}


// ============================================================
// Health endpoint
// ============================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',

        transcription: {
            engine: TRANSCRIPTION_ENGINE,
            model: transcriptionConfig.model,
            language: TRANSCRIPTION_LANGUAGE,
            url: transcriptionConfig.url
        }
    });
});


// ============================================================
// Start
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            `audio-journal listening on port ${PORT}`
        );

        console.log(
            `Transcription engine: ${TRANSCRIPTION_ENGINE}`
        );

        console.log(
            `Transcription model: ${transcriptionConfig.model}`
        );

        console.log(
            `Transcription language: ${TRANSCRIPTION_LANGUAGE}`
        );

        console.log(
            `Transcription URL: ${transcriptionConfig.url}`
        );
    }
);