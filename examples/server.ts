import { DictationPipeline } from "@dictation-kit/core";

const pipeline = new DictationPipeline({
  apiKey: process.env.GROQ_API_KEY!,
  transcriptionModel: "whisper-large-v3-turbo",
  cleanupModel: "openai/gpt-oss-20b",
});

// In a real route handler, build this Blob from the multipart audio uploaded by the browser.
export async function dictate(audio: Blob) {
  return pipeline.dictate(
    { data: audio, filename: "dictation.webm" },
    {
      language: "en",
      context: { appName: "Web Dictation", fieldType: "document" },
      vocabulary: ["Groq", "FreeFlow"],
    },
  );
}
