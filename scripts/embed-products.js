require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const axios = require("axios");

const prisma = new PrismaClient();

async function embedProducts() {
  const products = await prisma.product.findMany({
    include: { tag: true }, // Lấy luôn tag
  });

  for (const product of products) {
    const tagText = product.tag
      .map((t) => {
        const attrs = Object.entries(t.attributes || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join(", ");
        return attrs;
      })
      .join(" | ");

    const inputText = `${product.name} ${product.description || ""} ${tagText}`;

    try {
      const response = await axios.post(
        "https://api.openai.com/v1/embeddings",
        {
          input: inputText,
          model: "text-embedding-ada-002",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const embedding = response.data.data[0].embedding;

      await prisma.product.update({
        where: { productID: product.productID },
        data: { embedding },
      });

      console.log(`✅ Embedded product: ${product.name}`);
    } catch (err) {
      console.error(`❌ Error embedding product ${product.name}:`, err.message);
    }
  }

  console.log("🎉 Embedding process completed.");
  process.exit();
}

embedProducts();
