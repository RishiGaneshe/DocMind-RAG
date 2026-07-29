import "dotenv/config";

async function testVoyageEmbedding() {
  const apiKey = process.env.VOYAGE_API_KEY;

  if (!apiKey) {
    console.error("❌ VOYAGE_API_KEY is missing");
    process.exit(1);
  }

  console.log("Testing Voyage AI credentials...");
  console.log("API key loaded:", !!apiKey);

  try {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: ["Hello, this is a test for vector embeddings."],
        model: "voyage-4",
        input_type: "document",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Voyage API Error:");
      console.dir(data, { depth: null });

      console.error("HTTP Status:", response.status);
      return;
    }

    const embedding = data?.data?.[0]?.embedding;

    if (!embedding) {
      console.error("❌ No embedding returned");
      console.dir(data, { depth: null });
      return;
    }

    console.log("\n✅ Voyage AI credentials are working!");
    console.log("Model:", data.model);
    console.log("Vector dimensions:", embedding.length);
    console.log("First 10 values:", embedding.slice(0, 10));
  } catch (error) {
    console.error("❌ Request failed:");
    console.error(error);
  }
}

testVoyageEmbedding();
