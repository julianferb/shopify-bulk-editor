import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

interface GeminiInteractionResponse {
  id?: string;
  status?: string;
  output_text?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await authenticate.admin(request);

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return json(
      {
        ok: false,
        error: "GEMINI_API_KEY is not configured.",
      },
      { status: 500 },
    );
  }

  const body = await request.json();

  const {
    title,
    vendor,
    productType,
    categoryName,
    colors,
    aiDetails,
  } = body;

  if (!title?.trim()) {
    return json(
      {
        ok: false,
        error: "Product title is required.",
      },
      { status: 400 },
    );
  }

  const prompt = `
Generate ecommerce product content in Spanish.

Product information:
- Title: ${title || ""}
- Vendor: ${vendor || ""}
- Product type: ${productType || ""}
- Shopify category: ${categoryName || ""}
- Colors: ${
    Array.isArray(colors)
      ? colors.join(", ")
      : ""
  }
- Confirmed product details: ${aiDetails || ""}

Rules:
- Do not invent technical specifications.
- Do not invent materials.
- Care instructions may be generated only from confirmed materials or product type.
- Keep care instructions conservative and generic.
- Do not claim machine washing, waterproofing, special treatments, or temperature limits unless explicitly provided.
- If there is not enough information to suggest safe care instructions, leave careInstructions empty.
- careInstructions should contain 2 to 5 short practical instructions, separated by line breaks.
`;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash",

          input: prompt,

          generation_config: {
            thinking_level: "low",
          },

          response_format: {
            type: "text",
            mime_type: "application/json",
            schema: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                },
                features: {
                  type: "string",
                },
                materials: {
                  type: "string",
                },
                careInstructions: {
                  type: "string",
                },
                seoTitle: {
                  type: "string",
                },
                seoDescription: {
                  type: "string",
                },
                tags: {
                  type: "string",
                },
              },
              required: [
                "description",
                "features",
                "materials",
                "careInstructions",
                "seoTitle",
                "seoDescription",
                "tags",
              ],
            },
          },
        }),
      },
    );

    const data =
      (await response.json()) as GeminiInteractionResponse;

    if (!response.ok) {
      console.error("Gemini API error:", data);

      return json(
        {
          ok: false,
          error:
            data?.error?.message ??
            "Could not generate product content.",
        },
        { status: response.status },
      );
    }

    let outputText = data.output_text;

    // Compatibilidad por si output_text no viene directamente.
    if (!outputText && Array.isArray(data.steps)) {
      for (const step of data.steps) {
        if (step.type !== "model_output") {
          continue;
        }

        const textPart = step.content?.find(
          (part) =>
            part.type === "text" &&
            typeof part.text === "string",
        );

        if (textPart?.text) {
          outputText = textPart.text;
          break;
        }
      }
    }

    if (!outputText) {
      console.error(
        "Gemini returned no output text:",
        data,
      );

      return json(
        {
          ok: false,
          error:
            "Gemini returned an empty response.",
        },
        { status: 500 },
      );
    }

    const result = JSON.parse(outputText);

    return json({
      ok: true,
      content: {
        description:
          result.description ?? "",

        features:
          result.features ?? "",

        materials:
          result.materials ?? "",

        careInstructions:
          result.careInstructions ?? "",

        seoTitle:
          result.seoTitle ?? "",

        seoDescription:
          result.seoDescription ?? "",

        tags:
          result.tags ?? "",
      },
    });
  } catch (error) {
    console.error(
      "AI generation error:",
      error,
    );

    return json(
      {
        ok: false,
        error:
          "Could not generate product content.",
      },
      { status: 500 },
    );
  }
}