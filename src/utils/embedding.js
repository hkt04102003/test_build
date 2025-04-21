const { CohereClient } = require("cohere-ai");

const cohere = new CohereClient({
  token: process.env.COHERE_API_KEY, // Nhớ set .env
});

async function getEmbedding(text) {
  try {
    const res = await cohere.embed({
      texts: [text],
      model: "embed-english-v2.0", // hoặc "embed-multilingual-v2.0"
    });

    const embedding = res.embeddings[0];

    if (!embedding) throw new Error("No embedding returned");

    return embedding;
  } catch (err) {
    console.error("Error in getEmbedding:", err?.message || err);
    throw err;
  }
}

function cosineSimilarity(vecA, vecB) {
  const dotProduct = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magnitudeA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

async function getTopKSimilarProducts(inputText, matchedProducts, topK = 2) {
  const inputEmbedding = await getEmbedding(inputText);

  const scoredProducts = await Promise.all(
    matchedProducts.map(async (product) => {
      const productEmbedding = await getEmbedding(product.description);
      const similarity = cosineSimilarity(inputEmbedding, productEmbedding);
      return { ...product, similarity };
    })
  );

  scoredProducts.sort((a, b) => b.similarity - a.similarity);
  return scoredProducts.slice(0, topK);
}

module.exports = { getTopKSimilarProducts };
