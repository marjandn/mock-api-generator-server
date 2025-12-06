const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

let swaggerData = {};
let mockRoutes = [];

/* ---------------------------------------------
   Generate mock data recursively from schema
--------------------------------------------- */
function generateMockFromSchema(schema, components) {
  if (!schema) return null;

  if (schema.$ref) {
    const refName = schema.$ref.split("/").pop();
    return generateMockFromSchema(components[refName], components);
  }

  switch (schema.type) {
    case "object":
      const obj = {};
      for (const [key, value] of Object.entries(schema.properties || {})) {
        obj[key] = generateMockFromSchema(value, components);
      }
      return obj;

    case "array":
      return [
        generateMockFromSchema(schema.items, components),
        generateMockFromSchema(schema.items, components),
      ];

    case "string":
      return schema.example || "example string";

    case "integer":
    case "number":
      return schema.example || 123;

    case "boolean":
      return schema.example || true;

    default:
      return "mock value";
  }
}

/* ---------------------------------------------
   Remove existing mock routes
--------------------------------------------- */
function clearMockRoutes() {
  mockRoutes.forEach((route) => {
    app._router.stack = app._router.stack.filter(
      (layer) => !(layer.route && layer.route.path === route)
    );
  });
  mockRoutes = [];
}

/* ---------------------------------------------
   Setup dynamic mock API routes
--------------------------------------------- */
function setupMocks() {
  if (!swaggerData.paths) return;

  const components = swaggerData.components?.schemas || {};
  clearMockRoutes();

  for (const path in swaggerData.paths) {
    for (const method in swaggerData.paths[path]) {
      const exprPath = path.replace(/{/g, ":").replace(/}/g, "");
      mockRoutes.push(exprPath);

      console.log(
        `➡️ Registering mock route: [${method.toUpperCase()}] ${exprPath}`
      );

      app[method](exprPath, (req, res) => {
        const schema =
          swaggerData.paths[path][method].responses?.["200"]?.content?.[
            "application/json"
          ]?.schema;

        if (schema) {
          return res.json(generateMockFromSchema(schema, components));
        }

        return res.json({
          message: `Mocked ${method.toUpperCase()} ${path}`,
        });
      });
    }
  }
}

/* ---------------------------------------------
   Endpoint: Load Swagger URL (called by Flutter panel)
--------------------------------------------- */
app.post("/load-swagger", async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ message: "Swagger URL is required" });

  try {
    const result = await axios.get(url);
    swaggerData = result.data;

    setupMocks();

    const endpoints = Object.keys(swaggerData.paths || {});

    const protocol = req.get("x-forwarded-proto") || req.protocol;

    const baseUrl = `${protocol}://${req.get("host")}`;

    return res.json({
      message: "Mock API created successfully",
      endpoints,
      mockBaseUrl: baseUrl,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to load Swagger",
      error: err.message,
    });
  }
});

/* ---------------------------------------------
   Start server (Render uses process.env.PORT)
--------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Mock server running on port ${PORT}`);
});
