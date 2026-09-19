import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI, createUserContent, createPartFromUri } from "@google/genai";
import ffmpegPath from "ffmpeg-static";
import {
  downloadYouTubeVideo,
  downloadYouTubeSection,
  getYouTubeInfo,
  extractVideoId,
  getYouTubeTranscript,
  ensureYtDlp,
} from "./youtubeHelper.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

// Helper: Clear output directory of previously generated short videos
function clearOutputDir() {
  try {
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      for (const file of files) {
        const filePath = path.join(outputDir, file);
        try {
          fs.rmSync(filePath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`Failed to delete old output file ${file}:`, err.message);
        }
      }
      console.log("🧹 Output directory cleared of previous short videos.");
    }
  } catch (err) {
    console.error("Error clearing output directory:", err.message);
  }
}

app.use(cors());
app.use(express.json());

// Serve generated short videos statically
app.use("/output", express.static(outputDir));

// ================= GEMINI CLIENT & MODEL FALLBACK =================
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
});

const CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-flash-latest",
];

async function generateGeminiContent(options, retriesPerModel = 2) {
  let lastError = null;
  for (const model of CANDIDATE_MODELS) {
    for (let attempt = 0; attempt <= retriesPerModel; attempt++) {
      try {
        console.log(`Calling Gemini API using model: ${model} (attempt ${attempt + 1})...`);
        const response = await ai.models.generateContent({
          ...options,
          model,
        });
        if (response && (response.text || response.candidates?.length)) {
          return response;
        }
      } catch (err) {
        console.warn(`Model ${model} (attempt ${attempt + 1}) returned error: ${err.message}`);
        lastError = err;
        // If 503 (high demand) or 429 (rate limit), wait briefly before next attempt
        if (
          attempt < retriesPerModel &&
          (err.status === 503 ||
            err.status === 429 ||
            err.message?.includes("503") ||
            err.message?.includes("high demand") ||
            err.message?.includes("429"))
        ) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        } else if (
          err.status === 404 ||
          err.message?.includes("404") ||
          err.message?.includes("not found") ||
          err.message?.includes("no longer available")
        ) {
          // Model not found, skip immediately to next model
          break;
        }
      }
    }
  }
  throw lastError || new Error("All candidate Gemini models failed.");
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Remove markdown code fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object or array from string
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {}
    }
    console.error("Failed to parse JSON from Gemini text:", cleaned.substring(0, 200));
    return null;
  }
}

// Pre-warm yt-dlp binary check in background on start
ensureYtDlp()
  .then(() => console.log("✅ yt-dlp binary is ready."))
  .catch((err) => console.warn("yt-dlp auto-download warning:", err.message));

// ================= MULTER CONFIG =================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() +
      "-" +
      Math.round(Math.random() * 1e9) +
      path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/") || file.originalname.match(/\.(mp4|mov|avi|mkv|webm)$/i)) {
      cb(null, true);
    } else {
      cb(new Error("Only video files (MP4, MOV, MKV, WebM) are allowed"));
    }
  },
});

// ================= HELPER: ULTRA-FAST RENDER 9:16 SHORT WITH FFMPEG =================
async function renderShortClip(inputFilePath, outputPath, startSec = 0, durationSec) {
  const fastBlurFilter =
    "[0:v]scale=120:213:force_original_aspect_ratio=increase,crop=120:213,boxblur=2:1,scale=1080:1920:flags=fast_bilinear[bg];" +
    "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg];" +
    "[bg][fg]overlay=(W-w)/2:(H-h)/2";

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-ss",
      String(startSec),
      "-i",
      inputFilePath,
      "-t",
      String(durationSec),
      "-filter_complex",
      fastBlurFilter,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-r",
      "30",
      "-preset",
      "ultrafast",
      "-crf",
      "22",
      "-threads",
      "0",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } catch (err) {
    console.warn("Fast blur rendering failed, fallback to simple scale/pad:", err.message);
    try {
      await execFileAsync(ffmpegPath, [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        inputFilePath,
        "-t",
        String(durationSec),
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-r",
        "30",
        "-preset",
        "ultrafast",
        "-threads",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        outputPath,
      ]);
    } catch (padErr) {
      console.warn("Simple pad rendering failed, fallback to direct cut:", padErr.message);
      await execFileAsync(ffmpegPath, [
        "-y",
        "-ss",
        String(startSec),
        "-i",
        inputFilePath,
        "-t",
        String(durationSec),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        outputPath,
      ]);
    }
  }
}

// ================= HELPER: ANALYZE TRANSCRIPT WITH GEMINI =================
async function analyzeTranscriptWithGemini(transcriptText, title = "YouTube Video", clipCount = 5, targetDuration = 30) {
  const count = Math.max(1, Math.min(10, Number(clipCount) || 5));
  const durationGuidance = targetDuration && targetDuration > 0
    ? `Target duration for each clip should ideally be around ${targetDuration} seconds (between 20 and 60 seconds).`
    : `Duration for each clip should be between 20 and 60 seconds.`;

  const prompt = `
You are an expert viral YouTube Shorts and TikTok content editor.
Below is the full timestamped transcript of a video titled "${title}".

Analyze this transcript and find the top ${count} most engaging, viral, funny, dramatic, or high-value standalone moments.

Criteria:
1. Strong Opening Hook: Begins with a compelling question, fact, punchline, or bold statement.
2. Self-Contained: Has full context with a clear beginning, middle, and natural conclusion.
3. Clean Boundaries: Do not cut sentences in half.
4. ${durationGuidance}
5. Start and end timestamps must be in exact seconds (numbers).

Transcript:
${transcriptText.substring(0, 45000)}
`;

  const response = await generateGeminiContent({
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          clips: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "number", description: "Start time in seconds" },
                end: { type: "number", description: "End time in seconds" },
                title: { type: "string", description: "Catchy, viral Short title with emojis" },
                reason: { type: "string", description: "Why this segment will perform well as a Short" },
              },
              required: ["start", "end", "title", "reason"],
            },
          },
        },
        required: ["clips"],
      },
    },
  });

  const parsed = extractJson(response.text) || {};
  let clips = parsed.clips || [];
  if (!Array.isArray(clips) && Array.isArray(parsed)) {
    clips = parsed;
  }

  return (clips || []).filter(
    (c) => Number(c.end) > Number(c.start) && Number(c.end) - Number(c.start) >= 5
  );
}

// ================= HELPER: ANALYZE VIDEO WITH GEMINI FILES API =================
async function analyzeVideoWithGeminiFiles(videoFilePath, originalTitle = "Video", clipCount = 5, targetDuration = 30) {
  const count = Math.max(1, Math.min(10, Number(clipCount) || 5));
  let geminiFile = null;
  try {
    console.log("Uploading video to Gemini Files API...");
    geminiFile = await ai.files.upload({
      file: videoFilePath,
      config: {
        mimeType: "video/mp4",
      },
    });

    console.log("Gemini file uploaded:", geminiFile.name);

    while (
      geminiFile.state &&
      (geminiFile.state.toString() === "PROCESSING" || geminiFile.state.toString() === "STATE_UNSPECIFIED")
    ) {
      console.log("Gemini is processing video...");
      await new Promise((resolve) => setTimeout(resolve, 4000));
      geminiFile = await ai.files.get({
        name: geminiFile.name,
      });
    }

    if (geminiFile.state && geminiFile.state.toString() === "FAILED") {
      throw new Error("Gemini video processing failed.");
    }

    const prompt = `
You are an expert YouTube Shorts and TikTok viral content editor.
Analyze this video and identify the top ${count} best moments suitable for standalone Shorts.

Rules:
- Duration between 20 and 60 seconds (duration = end - start).
- Provide start and end timestamps in exact seconds.
- Provide a catchy title and reason for each clip.
`;

    const response = await generateGeminiContent({
      contents: createUserContent([
        createPartFromUri(geminiFile.uri, geminiFile.mimeType || "video/mp4"),
        prompt,
      ]),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            clips: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  start: { type: "number" },
                  end: { type: "number" },
                  title: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["start", "end", "title", "reason"],
              },
            },
          },
          required: ["clips"],
        },
      },
    });

    const parsed = extractJson(response.text) || {};
    let clips = parsed.clips || [];
    if (!Array.isArray(clips) && Array.isArray(parsed)) {
      clips = parsed;
    }

    return (clips || []).filter(
      (c) => Number(c.end) > Number(c.start) && Number(c.end) - Number(c.start) >= 5
    );
  } finally {
    if (geminiFile?.name) {
      try {
        await ai.files.delete({ name: geminiFile.name });
      } catch (e) {}
    }
  }
}

// ================= API ROUTES =================

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "🎬 AI Short Maker API is active & running!",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here"),
  });
});

app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "🎬 AI Short Maker API is active & running!",
  });
});

app.get("/", (req, res, next) => {
  const frontendDist = path.join(__dirname, "../frontend/dist");
  if (fs.existsSync(frontendDist)) {
    return res.sendFile(path.join(frontendDist, "index.html"));
  }
  res.json({
    success: true,
    message: "🎬 AI Short Maker API is active & running!",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "your_gemini_api_key_here"),
  });
});

// YouTube Metadata Route (oEmbed)
app.post("/api/youtube-info", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: "YouTube URL is required." });
    }

    const info = await getYouTubeInfo(url);
    res.json({ success: true, data: info });
  } catch (error) {
    console.error("YouTube Info Error:", error.message);
    res.status(500).json({ success: false, message: error.message || "Failed to fetch YouTube video info." });
  }
});

const getBaseUrl = (req) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${protocol}://${host}`;
};

// LIGHTNING-FAST: Process YouTube URL to Shorts
app.post("/api/process-youtube", async (req, res) => {
  try {
    const { url, clipCount = 5, targetDuration = 30 } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, message: "Please provide a valid YouTube URL." });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ success: false, message: "Invalid YouTube URL format." });
    }

    // Automatically delete old short videos before generating new ones
    clearOutputDir();

    const baseUrl = getBaseUrl(req);
    console.log(`[Lightning-Fast] Processing YouTube video: ${url} (${clipCount} clips requested)`);
    const meta = await getYouTubeInfo(url);
    const videoTitle = meta.title || "YouTube Video";

    // 1. Try transcript-based instant detection
    let validClips = [];
    try {
      const transcript = await getYouTubeTranscript(videoId);
      if (transcript) {
        console.log("⚡ Transcript found! Analyzing with Gemini...");
        validClips = await analyzeTranscriptWithGemini(transcript, videoTitle, clipCount, targetDuration);
      }
    } catch (transcriptErr) {
      console.warn("Transcript analysis notice:", transcriptErr.message);
    }

    // 2A. Direct Section Slicing (Lightning-fast: downloads only the required 30s chunks in parallel!)
    if (validClips && validClips.length > 0) {
      console.log(`⚡ Direct Section Slicing: Downloading and rendering ${validClips.length} chunks in parallel...`);

      const clipPromises = validClips.map(async (clip, index) => {
        const duration = Math.max(5, Math.min(60, clip.end - clip.start));
        const sectionRawFile = path.join(uploadsDir, `sec-${Date.now()}-${index + 1}.mp4`);
        const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
        const outputPath = path.join(outputDir, outputFileName);

        try {
          await downloadYouTubeSection(videoId, clip.start, clip.end, sectionRawFile);
          await renderShortClip(sectionRawFile, outputPath, 0, duration);

          if (fs.existsSync(sectionRawFile)) {
            fs.unlink(sectionRawFile, () => {});
          }

          return {
            id: `clip-${index + 1}-${Date.now()}`,
            title: clip.title || `${videoTitle} Part ${index + 1}`,
            reason: clip.reason || "High engagement viral clip",
            start: clip.start,
            end: clip.end,
            duration: Math.round(duration),
            videoUrl: `${baseUrl}/output/${outputFileName}`,
            fileName: outputFileName,
          };
        } catch (clipErr) {
          console.warn(`Section processing warning for clip ${index + 1}:`, clipErr.message);
          if (fs.existsSync(sectionRawFile)) fs.unlink(sectionRawFile, () => {});
          return null;
        }
      });

      const generatedClips = (await Promise.all(clipPromises)).filter(Boolean);

      if (generatedClips.length > 0) {
        return res.json({
          success: true,
          message: `⚡ Successfully generated ${generatedClips.length} AI Shorts in seconds!`,
          videoTitle,
          clips: generatedClips,
        });
      }
    }

    // 2B. Fallback: Download full video if section slicing or transcript was not completely successful
    console.log("Downloading video stream with yt-dlp...");
    const tempFileName = `yt-${Date.now()}-${Math.round(Math.random() * 1e6)}.mp4`;
    const downloadedFilePath = path.join(uploadsDir, tempFileName);
    await downloadYouTubeVideo(url, downloadedFilePath);

    // If validClips were not already identified from transcript, analyze with Gemini Files API
    if (!validClips || validClips.length === 0) {
      try {
        console.log("Analyzing downloaded video with Gemini Files API...");
        validClips = await analyzeVideoWithGeminiFiles(downloadedFilePath, videoTitle, clipCount, targetDuration);
      } catch (geminiFileErr) {
        console.warn("Gemini Files API analysis warning:", geminiFileErr.message);
      }
    }

    // If still no clips detected, create default highlight segments across the video
    if (!validClips || validClips.length === 0) {
      console.log("Generating highlight segments from video...");
      const duration = Math.min(45, targetDuration || 30);
      const totalShorts = Math.max(1, Math.min(clipCount || 5, 5));
      validClips = Array.from({ length: totalShorts }, (_, i) => ({
        start: i * (duration + 10) + 5,
        end: i * (duration + 10) + 5 + duration,
        title: `${videoTitle} Highlight #${i + 1}`,
        reason: "Engaging viral moment from video",
      }));
    }

    const clipPromises = validClips.map(async (clip, index) => {
      const duration = Math.max(5, Math.min(60, clip.end - clip.start));
      const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
      const outputPath = path.join(outputDir, outputFileName);

      await renderShortClip(downloadedFilePath, outputPath, clip.start, duration);

      return {
        id: `clip-${index + 1}-${Date.now()}`,
        title: clip.title || `${videoTitle} Part ${index + 1}`,
        reason: clip.reason || "High engagement viral clip",
        start: clip.start,
        end: clip.end,
        duration: Math.round(duration),
        videoUrl: `${baseUrl}/output/${outputFileName}`,
        fileName: outputFileName,
      };
    });

    const generatedClips = await Promise.all(clipPromises);

    if (fs.existsSync(downloadedFilePath)) {
      fs.unlink(downloadedFilePath, () => {});
    }

    res.json({
      success: true,
      message: `Successfully generated ${generatedClips.length} AI Shorts!`,
      videoTitle,
      clips: generatedClips,
    });
  } catch (error) {
    console.error("YouTube Processing Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to process YouTube video.",
    });
  }
});

// Process Uploaded Video File to Shorts (Parallel FFmpeg)
app.post("/api/analyze-video", upload.single("video"), async (req, res) => {
  let uploadedFilePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a video file.",
      });
    }

    // Automatically delete old short videos before generating new ones
    clearOutputDir();

    const baseUrl = getBaseUrl(req);
    const clipCount = Number(req.body.clipCount) || 5;
    const targetDuration = Number(req.body.targetDuration) || 30;

    uploadedFilePath = req.file.path;
    console.log("Local video file uploaded:", uploadedFilePath, "Requested clips:", clipCount);

    const originalName = req.file.originalname.replace(/\.[^/.]+$/, "");
    let validClips = [];

    try {
      validClips = await analyzeVideoWithGeminiFiles(uploadedFilePath, originalName, clipCount, targetDuration);
    } catch (err) {
      console.warn("Gemini video file analysis warning:", err.message);
    }

    // Fallback if Gemini could not analyze video file
    if (!validClips || validClips.length === 0) {
      console.log("Generating highlight segments for uploaded video...");
      const duration = Math.min(45, targetDuration || 30);
      const totalShorts = Math.max(1, Math.min(clipCount || 5, 5));
      validClips = Array.from({ length: totalShorts }, (_, i) => ({
        start: i * (duration + 10) + 2,
        end: i * (duration + 10) + 2 + duration,
        title: `${originalName} Highlight #${i + 1}`,
        reason: "Engaging viral moment",
      }));
    }

    const clipPromises = validClips.map(async (clip, index) => {
      const duration = Math.max(5, Math.min(60, clip.end - clip.start));
      const outputFileName = `short-${Date.now()}-${index + 1}.mp4`;
      const outputPath = path.join(outputDir, outputFileName);

      await renderShortClip(uploadedFilePath, outputPath, clip.start, duration);

      return {
        id: `clip-${index + 1}-${Date.now()}`,
        title: clip.title || `${originalName} Highlight`,
        reason: clip.reason || "Engaging viral moment",
        start: clip.start,
        end: clip.end,
        duration: Math.round(duration),
        videoUrl: `${baseUrl}/output/${outputFileName}`,
        fileName: outputFileName,
      };
    });

    const generatedClips = await Promise.all(clipPromises);

    if (fs.existsSync(uploadedFilePath)) {
      fs.unlink(uploadedFilePath, () => {});
    }

    res.json({
      success: true,
      message: `Successfully generated ${generatedClips.length} AI Shorts!`,
      clips: generatedClips,
    });
  } catch (error) {
    console.error("Video Upload Processing Error:", error);

    if (uploadedFilePath && fs.existsSync(uploadedFilePath)) {
      fs.unlink(uploadedFilePath, () => {});
    }

    res.status(500).json({
      success: false,
      message: error.message || "Failed to analyze and process video.",
    });
  }
});

// Generate Viral Script Route
app.post("/api/generate-script", async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || !topic.trim()) {
      return res.status(400).json({
        success: false,
        message: "Topic is required to generate script.",
      });
    }

    const response = await generateGeminiContent({
      contents: `
You are a top-tier viral YouTube Shorts and TikTok content creator.
Create a high-energy, engaging 30-60 second viral script on the following topic:

Topic: "${topic}"

Structure the script in this clean format:
🎯 [HOOK - First 3 seconds to grab attention]:
⚡ [BODY - 3 Quick, Mind-blowing points or story]:
🔥 [CALL TO ACTION / CONCLUSION - Final 5 seconds]:
💡 [CREATOR TIP: Recommended visual or sound effect]:
`,
    });

    res.json({
      success: true,
      script: response.text,
    });
  } catch (error) {
    console.error("Script Generation Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to generate script using Gemini.",
    });
  }
});


// Serve frontend static build in production
const frontendDist = path.join(__dirname, "../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/output")) {
      return res.sendFile(path.join(frontendDist, "index.html"));
    }
    next();
  });
}

// Global Error Handler
app.use((error, req, res, next) => {
  console.error("Server Unhandled Error:", error);
  res.status(500).json({
    success: false,
    message: error.message || "Internal server error",
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 AI Short Maker Backend is running at http://localhost:${PORT}`);
});
