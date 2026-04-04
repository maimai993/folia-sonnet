export const config = {
    runtime: 'edge', // Use edge runtime for fetch support
};

export default async function handler(req: Request) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    try {
        const { lyricsText, isPureMusic = false, songTitle } = await req.json();

        if (!lyricsText) {
            return new Response(JSON.stringify({ error: 'Missing lyricsText' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        const apiKey = process.env.OPENAI_API_KEY;
        const apiUrl = process.env.OPENAI_API_URL || "https://api.openai.com/v1/chat/completions";

        if (!apiKey) {
            console.error("OpenAI API Key is missing in server environment.");
            return new Response(JSON.stringify({ error: 'Server configuration error' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Limit text to avoid token limits if lyrics are huge
        const snippet = lyricsText.slice(0, 2000);

        const prompt = `Analyze the mood of the provided song source text and generate TWO visual theme configurations for a music player - one for LIGHT mode and one for DARK mode.

DUAL THEME REQUIREMENTS:
1. Generate TWO complete themes: one optimized for LIGHT/DAYLIGHT mode, one for DARK/MIDNIGHT mode.
2. Both themes should capture the SAME emotional essence of the source text, but with appropriate color palettes for their respective modes.
3. The theme names should reflect both the mood AND the mode (e.g., "Melancholic Dawn" for light, "Melancholic Midnight" for dark).

SOURCE MODE:
1. If 'Pure instrumental' is yes, the source text below is the song title of a pure instrumental track, not lyrics.
2. If 'Pure instrumental' is no, the source text below is a lyrics snippet.
3. Base your mood inference only on the provided source text.

LIGHT THEME RULES:
- Use LIGHT backgrounds (whites, creams, soft pastels, etc.).
- Ensure text/icons are dark enough for contrast.
- 'accentColor' must be visible against the light background.

DARK THEME RULES:
- Use DARK backgrounds (deep colors, near-black tones, etc.).
- Ensure text/icons are light enough for contrast.

SHARED RULES FOR BOTH THEMES:
1. CRITICAL for 'secondaryColor': This color is used for secondary TEXT (e.g., album name, artist name).
    - It MUST have sufficient contrast against 'backgroundColor' to be easily readable.
    - Aim for a contrast ratio of at least 4.5:1 for accessibility.
2. 'wordColors' and 'lyricsIcons' should be the SAME for both themes (they represent the source text's meaning).

IMPORTANT for 'wordColors':
1. Identify 5-10 key emotional words or phrases from the source text.
2. If the source text is a very short pure-instrumental title, you may return fewer entries.
3. Assign a specific color to each word that represents its emotion.
4. CRITICAL: The 'word' field MUST match the EXACT text in the source snippet (case-insensitive).
   If the pure-instrumental title is very short, using the exact full title as a phrase is allowed.

IMPORTANT for 'lyricsIcons':
1. Identify 3-5 visual concepts/objects mentioned in or strongly implied by the source text.
2. Return them as valid Lucide React icon names (PascalCase, e.g., 'CloudLightning', 'HeartHandshake').

Response MUST be a valid JSON object. Do not include markdown formatting like \`\`\`json. Just the raw JSON.

Pure instrumental: ${isPureMusic ? 'yes' : 'no'}
${isPureMusic && songTitle ? `Song title: ${songTitle}\n` : ''}Source snippet:
${snippet}

JSON Schema:
{
  "type": "object",
  "properties": {
    "light": {
      "type": "object",
      "description": "Theme optimized for light/daylight mode",
      "properties": {
        "name": { "type": "string", "description": "A creative name for this light theme" },
        "backgroundColor": { "type": "string", "description": "Hex code for light background" },
        "primaryColor": { "type": "string", "description": "Hex code for main text (dark)" },
        "accentColor": { "type": "string", "description": "Hex code for highlighted text/effects" },
        "secondaryColor": { "type": "string", "description": "Hex code for secondary elements" },
        "wordColors": {
          "type": "array",
          "description": "List of exact emotional words or phrases from the source text and their specific colors",
          "items": {
            "type": "object",
            "properties": {
              "word": { "type": "string" },
              "color": { "type": "string" }
            },
            "required": ["word", "color"]
          }
        },
        "lyricsIcons": {
          "type": "array",
          "description": "List of Lucide icon names related to the source text",
          "items": { "type": "string" }
        }
      },
      "required": ["name", "backgroundColor", "primaryColor", "accentColor", "secondaryColor"]
    },
    "dark": {
      "type": "object",
      "description": "Theme optimized for dark/midnight mode",
      "properties": {
        "name": { "type": "string", "description": "A creative name for this dark theme" },
        "backgroundColor": { "type": "string", "description": "Hex code for dark background" },
        "primaryColor": { "type": "string", "description": "Hex code for main text (light)" },
        "accentColor": { "type": "string", "description": "Hex code for highlighted text/effects" },
        "secondaryColor": { "type": "string", "description": "Hex code for secondary elements" },
        "wordColors": {
          "type": "array",
          "description": "List of exact emotional words or phrases from the source text and their specific colors",
          "items": {
            "type": "object",
            "properties": {
              "word": { "type": "string" },
              "color": { "type": "string" }
            },
            "required": ["word", "color"]
          }
        },
        "lyricsIcons": {
          "type": "array",
          "description": "List of Lucide icon names related to the source text",
          "items": { "type": "string" }
        }
      },
      "required": ["name", "backgroundColor", "primaryColor", "accentColor", "secondaryColor"]
    }
  },
  "required": ["light", "dark"]
}`;

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are a helpful assistant that generates JSON themes for music players." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7,
                response_format: { type: "json_object" }
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error("OpenAI API Error:", response.status, errText);
            throw new Error(`OpenAI API error: ${response.statusText}`);
        }

        const data = await response.json();
        const content = data.choices[0]?.message?.content;

        if (!content) {
            throw new Error("Failed to generate theme JSON");
        }

        // Attempt to parse JSON
        let dualTheme;
        let jsonStr = content.trim();

        // Remove markdown code blocks if present
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(json)?\n/, '').replace(/\n```$/, '');
        }

        try {
            dualTheme = JSON.parse(jsonStr);
        } catch (e) {
            console.error("Failed to parse JSON from AI response:", jsonStr);
            throw new Error("Invalid JSON response from AI");
        }

        // Force fixed properties for both themes
        dualTheme.light.fontStyle = 'sans';
        dualTheme.light.provider = 'OpenAI Compatible';
        dualTheme.light.animationIntensity = 'normal';
        dualTheme.dark.fontStyle = 'sans';
        dualTheme.dark.provider = 'OpenAI Compatible';
        dualTheme.dark.animationIntensity = 'normal';

        return new Response(JSON.stringify(dualTheme), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    } catch (error) {
        console.error("Error generating theme:", error);
        const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
        return new Response(JSON.stringify({ error: errorMessage }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
