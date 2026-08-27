const GEMINI_KEY = process.env.GEMINI_SERVER_KEY;
const GEMINI_MODEL = "gemini-3.6-flash";

exports.handler = async function (event) {
  // Only allow POST requests
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    // Check that the Gemini key exists
    if (!GEMINI_KEY) {
      console.error("GEMINI_SERVER_KEY is missing");
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Gemini server key is not configured.",
        }),
      };
    }

    const body = JSON.parse(event.body || "{}");

    const contents = body.contents;
    const systemInstruction = body.systemInstruction;
    const maxTokens = body.maxTokens || 800;

    if (!contents) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Missing request content",
        }),
      };
    }

    const geminiBody = {
      contents: contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
      },
    };

    if (systemInstruction) {
      geminiBody.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL +
      ":generateContent?key=" +
      GEMINI_KEY;

    console.log("Calling Gemini model:", GEMINI_MODEL);

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(geminiBody),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error("Gemini API error:", data);

      return {
        statusCode: geminiRes.status,
        body: JSON.stringify({
          error:
            data &&
            data.error &&
            data.error.message
              ? data.error.message
              : "AI request failed",
        }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error("AI proxy error:", error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Couldn't reach SAM-X. Please try again.",
      }),
    };
  }
};