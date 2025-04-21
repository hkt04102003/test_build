const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { Prisma, PrismaClient } = require("@prisma/client");
const NodeCache = require("node-cache");
dotenv.config();

const app = express();
const prisma = new PrismaClient();
const llmCache = new NodeCache({ stdTTL: 86400 }); // Cache for 24 hours
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Initialize OpenAI client
const client = new OpenAI({
  baseURL: "https://models.inference.ai.azure.com",
  apiKey: process.env.OPENAI_API_KEY,
});

const attributesPath = path.join(__dirname, "attributes.json");
let attributes = [];
try {
  attributes = JSON.parse(fs.readFileSync(attributesPath, "utf8"));
} catch (err) {
  console.error("Failed to load attributes.json:", err);
  process.exit(1);
}

const productTypes = [
  { en: "sweaters", vi: ["áo len", "áo chui đầu", "sweater"] },
  { en: "sweatershirts", vi: ["áo nỉ", "áo nỉ có mũ", "sweatershirt"] },
  { en: "trousers", vi: ["quần dài", "quần âu", "pants", "trouser"] },
  { en: "tShirts", vi: ["áo thun", "áo phông", "t-shirt", "áo"] },
  { en: "blouses", vi: ["áo kiểu", "áo sơ mi nữ", "blouse"] },
  { en: "jeans", vi: ["quần jeans", "quần bò"] },
  { en: "jackets", vi: ["áo khoác", "jacket"] },
  { en: "shorts", vi: ["quần đùi", "short"] },
  { en: "dresses", vi: ["váy", "đầm", "dress"] },
];

const specialCases = {
  "bộ đồ": [
    { type: "tShirts", attributes: {} },
    { type: "jeans", attributes: {} },
  ],
  "bộ đồ bơi": [
    { type: "tShirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
  "bộ đồ đi làm": [
    { type: "blouses", attributes: {} },
    { type: "trousers", attributes: {} },
  ],
  "bộ đồ đi chơi": [
    { type: "tShirts", attributes: {} },
    { type: "jeans", attributes: {} },
  ],
  "bộ đồ mùa đông": [
    { type: "jackets", attributes: {} },
    { type: "jeans", attributes: {} },
  ],
  "bộ đồ mùa hè": [
    { type: "tShirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
  "bộ đồ thể thao": [
    { type: "sweatershirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
  "đồ công sở": [
    { type: "blouses", attributes: {} },
    { type: "trousers", attributes: {} },
  ],
  "đồ mặc nhà": [
    { type: "tShirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
  "đồ ngủ": [
    { type: "tShirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
  "đồ thu đông": [
    { type: "sweaters", attributes: {} },
    { type: "jeans", attributes: {} },
  ],
  "đồ hè": [
    { type: "tShirts", attributes: {} },
    { type: "shorts", attributes: {} },
  ],
};

function checkSpecialCase(userInput) {
  const lowerInput = userInput.toLowerCase();
  if (lowerInput.includes("áo") || lowerInput.includes("quần")) {
    return null;
  }

  for (const keyword in specialCases) {
    if (lowerInput.includes(keyword)) {
      return { products: specialCases[keyword] };
    }
  }

  return null;
}

function detectProductType(input) {
  const lower = input.toLowerCase();
  return (
    productTypes.find(
      (type) =>
        type.vi.some((term) => lower.includes(term)) || lower.includes(type.en)
    )?.en || null
  );
}

async function fetchAIAttributesWithCache(userInput, attributes) {
  // Create a cache key based on the input and attributes
  const cacheKey = `${userInput}-${JSON.stringify(attributes)}`;

  // Check cache first
  const cachedResponse = llmCache.get(cacheKey);
  if (cachedResponse) {
    console.log("Cache hit for:", userInput);
    return cachedResponse;
  }

  console.log("Cache miss for:", userInput);

  // If not in cache, make the API call
  const response = await fetchAIAttributes(userInput, attributes);

  // Store the response in cache
  llmCache.set(cacheKey, response);

  return response;
}

async function fetchAIAttributes(userInput, attributes) {
  const attributeList = attributes
    .map((attr) => `${attr.name}: ${attr.value}`)
    .join("\n");

  const prompt = `
    Bạn là trợ lý mua sắm thông minh cho cửa hàng thời trang người lớn. Hãy trích xuất thông tin sản phẩm từ yêu cầu:
    
    **Yêu cầu:** "${userInput}"
    
    **Thuộc tính hỗ trợ:**
    ${attributeList}
    
    **Quy tắc:**
    1. Suy luận thuộc tính từ ngữ cảnh (ví dụ: "đi Hàn Quốc" -> mùa đông, "tuổi teen" -> style năng động)
    2. Phân tích cả yêu cầu trực tiếp và gián tiếp
    3. Câu hỏi mơ hồ -> Ví dụ: "điều ước", "một ngày tuyệt vời", "mình buồn quá",...-> { "unknown": true }
    
    4. Nếu người dùng search "quần áo" hoặc "áo quần" hoặc "bộ đồ",...:
      - Nếu là "bộ đồ [ngữ cảnh]" (ví dụ: "bộ đồ đi làm") -> trả về 1 sản phẩm với type rỗng và attributes phù hợp ngữ cảnh
      - Nếu chỉ là "bộ đồ"/"quần áo" chung chung -> trả về danh sách các sản phẩm có thể kết hợp (áo + quần)
      
      Ví dụ:
      - "bộ đồ đi làm" => {
          "products": [{
            "type": "",
            "attributes": {
              "style": "Công sở"
            }
          }]
        }
      - "quần áo" => {
          "products": [
            {"type": "tShirts", "attributes": {}},
            {"type": "trousers", "attributes": {}}
          ]
        }
        -Nếu là "bộ đồ [ngữ cảnh]" + attribute hoặc "bộ đồ"/"quần áo" chung chung + attribute -> trả về danh sách các sản phẩm có thể kết hợp (áo + quần) + attribute
    5. Nếu không tìm thấy sản phẩm nào, hãy trả về { "unknown": true }
    6. Suy luận đến trạng thái thời tiết để đưa ra loại trang phục phù hợp (nếu có thể)(ví dụ : trời mưa -> Sweaters, áo khoác và Trousers hoặc Jeans; trời lạnh -> áo  khoác và quần jeans)
    7. Suy luận loại sản phẩm phù hợp với ngữ cảnh quốc gia để hỏi phù hợp gần nhất với ${productTypes
      .map((p) => p.en)
      .join(
        ", "
      )} ( ví dụ : nếu style hàn quốc thì hãy kiếm những ${productTypes
    .map((p) => p.en)
    .join(", ")} mà người hàn quốc mặc nhiều,...)
    8. Với 1 số trường hợp đặc biệt tự suy luận ra để đúng hợp ý với người dùng ( ví dụ Nếu người dùng nhắc đến "bà bầu", hãy ưu tiên các sản phẩm  "thoải mái", "rộng rãi" như tShirts, blouses, trousers.;Nếu người dùng đề cập đến tập gym, thể thao,... hãy ưu tiên style là "năng động", chọn tShirts, sweatershirts, shorts hoặc trousers tùy thời tiết.;...)
    9. Nếu yêu cầu liên quan đến dịp lễ như "Noel", "Giáng Sinh",..., hãy suy luận thời tiết là mùa đông.  
    - Ưu tiên jackets, sweaters, trousers, jeans.  
    - Nếu người dùng nhắc tone màu (ví dụ: đỏ, trắng), hãy gán vào thuộc tính "color".  
    - Nếu yêu cầu có style như "cá tính", "nổi bật", hãy gán vào "style".
    10. Suy luận loại sản phẩm phù hợp với từng khu vực để  phù hợp gần nhất với ${productTypes
      .map((p) => p.en)
      .join(
        ", "
      )} (ví dụ : nếu được hỏi trang phục ở hồ chí minh thì hãy kiếm những ${productTypes
    .map((p) => p.en)
    .join(", ")} mà người ở hồ chí minh mặc nhiều mặc nhiều,...)
    **Output JSON mẫu:**
    {
      "products": [
        {
          "type": "áo khoác",
          "attributes": {
            "season": "đông",
            "style": "Năng động",
            "color": "xanh"
          }
        }
      ]
    }
    
    **Lưu ý quan trọng:**
    - "type" phải dùng từ khóa Tiếng Anh (tShirts, jeans,...)
    - "type" phải sử dụng đúng ở trong ${productTypes
      .map((p) => p.en)
      .join(", ")}
    - Phải trả lời chính xác cái attribute có trong danh sách thuộc tính hỗ trợ
    - Bỏ qua thuộc tính không có trong danh sách thuộc tính hỗ trợ ( ví dụ : dài, ngắn,...)
    - Tự động suy luận: quốc gia -> mùa/địa điểm -> phong cách
    `;

  const response = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: "Extract attributes. Respond with valid JSON only.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
    max_tokens: 200,
    response_format: { type: "json_object" },
  });

  return JSON.parse(response.choices[0].message.content);
}

function normalizeProducts(rawProducts) {
  return rawProducts.map((p) => {
    const normalizedType = (detectProductType(p.type) || p.type).toLowerCase();
    const attributes =
      p.attributes && typeof p.attributes === "object" ? p.attributes : {};
    return { type: normalizedType, attributes };
  });
}

async function matchProducts(normalizedProducts) {
  const results = [];

  for (const item of normalizedProducts) {
    // Kiểm tra nếu cả item.type và item.attributes đều thiếu
    if ((!item.type || item.type.trim() === "") && 
        (!item.attributes || Object.keys(item.attributes).length === 0)) {
      continue;  // Bỏ qua nếu thiếu cả 2
    }

    console.log("\n🔍 Đang xử lý sản phẩm:", item);

    // Tạo các truy vấn cho thuộc tính (attribute) của sản phẩm
    const attributeQueries = Object.entries(item.attributes || {}).map(([key, value]) => {
      if (!value) return null;

      return Prisma.sql`
        EXISTS (
          SELECT 1 FROM "Tag" t
          WHERE t."productId" = p."productID"
          AND t.attributes::text LIKE ${`%${value}%`}
        )
      `;
    }).filter(Boolean); // bỏ qua các giá trị null

    // Tạo điều kiện cho `type` (category)
    const typeCondition =
      item.type && item.type.trim() !== ""
        ? Prisma.sql`p.category ILIKE ${item.type}`
        : null;

    let conditions = [];

    if (item.type && item.type.trim() !== "" && attributeQueries.length > 0) {
      // Nếu cả `type` và `attributes` đều có giá trị, sử dụng AND
      conditions.push(
        Prisma.sql`
          (${Prisma.join(attributeQueries, " AND ")}) 
          AND 
          (${typeCondition})
        `
      );
    } else {
      // Nếu chỉ có `type` hoặc `attributes`, sử dụng OR
      if (attributeQueries.length > 0) {
        conditions.push(Prisma.sql`(${Prisma.join(attributeQueries, " OR ")})`);
      }
      if (typeCondition) {
        conditions.push(typeCondition);
      }
    }

    // Nếu không có điều kiện nào, bỏ qua sản phẩm này
    if (conditions.length === 0) {
      continue;
    }

    const query = Prisma.sql`
      SELECT p.* FROM "Product" p
      WHERE ${Prisma.join(conditions, " OR ")}
    `;

    console.log("\n📜 Truy vấn sẽ chạy:\n", query.text);

    try {
      const matched = await prisma.$queryRaw(query);

      console.log("✅ Kết quả trả về:", matched.length, "sản phẩm");

      const withTags = await Promise.all(
        matched.map(async (product) => {
          const tags = await prisma.tag.findMany({
            where: { productId: product.productID },
          });

          return { ...product, tag: tags };
        })
      );

      results.push(...withTags);
    } catch (error) {
      console.error("❌ Raw query error:", error);
    }
  }

  const uniqueResults = Array.from(
    new Map(results.map((p) => [p.productID.toString(), p])).values()
  );

  console.log("📦 Tổng kết quả sau lọc trùng:", uniqueResults.length);

  return uniqueResults.map((product) => ({
    productID: product.productID.toString(),
    description: product.description,
    type: product.category?.toLowerCase(),
    tag: product.tag.reduce((acc, tag) => {
      if (tag.attributes && typeof tag.attributes === "object") {
        for (const [k, v] of Object.entries(tag.attributes)) {
          if (v) {
            acc[k] = acc[k] || new Set();
            acc[k].add(typeof v === "string" ? v.toLowerCase() : v.toString());
          }
        }
      }
      return acc;
    }, {}),
  }));
}


app.post("/analyze-input", async (req, res) => {
  try {
    const userInput = req.body.text;
    if (!userInput)
      return res.status(400).json({ error: "Missing input text" });

    const extracted = await fetchAIAttributesWithCache(userInput, attributes);
    if (extracted.unknown)
      return res.json({ message: "No product intent detected." });

    const normalizedProducts = normalizeProducts(extracted.products || []);
    console.log(
      "normalizeProducts : ",
      JSON.stringify(normalizedProducts, null, 2)
    );
    const productMap = await matchProducts(normalizedProducts);
    console.log("Matched products:", productMap);
    const matched = [];
    const matchedProductIDs = new Set();
    for (const norm of normalizedProducts) {
      for (const product of productMap) {
        if (product.type !== norm.type) continue;

        const isMatch = Object.entries(norm.attributes).every(([key, val]) =>
          product.tag[key]?.has(val.toLowerCase())
        );

        if (isMatch) {
          matchedProductIDs.add(product.productID);
          matched.push({
            productID: product.productID,
            description: product.description,
          });
        }
      }
    }
    console.log({
      productID: Array.from(matchedProductIDs),
      userInput,
    });
    res.json({
      normalizedProducts: normalizedProducts,
      cached: llmCache
        .keys()
        .includes(`${userInput}-${JSON.stringify(attributes)}`),
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ error: "Internal error", details: err.message });
  }
});

app.get("/debug-products", async (req, res) => {
  const products = await prisma.product.findMany({ include: { tag: true } });
  const result = JSON.parse(
    JSON.stringify(products, (key, val) =>
      typeof val === "bigint" ? val.toString() : val
    )
  );
  res.json(result);
});

app.get("/cache-info", (req, res) => {
  res.json({
    cacheSize: llmCache.keys().length,
    cacheKeys: llmCache.keys(),
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
