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
   Resolve schema reference ($ref)
--------------------------------------------- */
function resolveSchema(schema, components) {
  if (!schema) return null;
  
  if (schema.$ref) {
    const refPath = schema.$ref.split("/");
    if (refPath[0] === "#" && refPath[1] === "components") {
      const refName = refPath[refPath.length - 1];
      return components[refName] || null;
    }
  }
  
  return schema;
}

/* ---------------------------------------------
   Extract full schema structure recursively
--------------------------------------------- */
function extractSchemaStructure(schema, components, depth = 0) {
  if (depth > 10) return { type: "object", description: "Max depth reached" }; // Prevent infinite recursion
  
  if (!schema) return null;
  
  // Resolve $ref
  const resolved = resolveSchema(schema, components);
  if (!resolved) return null;
  
  const result = {
    type: resolved.type,
    format: resolved.format,
    description: resolved.description,
    example: resolved.example,
    default: resolved.default,
    enum: resolved.enum,
    minimum: resolved.minimum,
    maximum: resolved.maximum,
    minLength: resolved.minLength,
    maxLength: resolved.maxLength,
    pattern: resolved.pattern,
  };
  
  // Handle object types
  if (resolved.type === "object" || resolved.properties) {
    result.type = "object";
    result.properties = {};
    for (const [key, value] of Object.entries(resolved.properties || {})) {
      result.properties[key] = extractSchemaStructure(value, components, depth + 1);
    }
    result.required = resolved.required || [];
  }
  
  // Handle array types
  if (resolved.type === "array" || resolved.items) {
    result.type = "array";
    result.items = extractSchemaStructure(resolved.items, components, depth + 1);
    result.minItems = resolved.minItems;
    result.maxItems = resolved.maxItems;
  }
  
  // Handle allOf, anyOf, oneOf
  if (resolved.allOf) {
    result.allOf = resolved.allOf.map(s => extractSchemaStructure(s, components, depth + 1));
  }
  if (resolved.anyOf) {
    result.anyOf = resolved.anyOf.map(s => extractSchemaStructure(s, components, depth + 1));
  }
  if (resolved.oneOf) {
    result.oneOf = resolved.oneOf.map(s => extractSchemaStructure(s, components, depth + 1));
  }
  
  return result;
}

/* ---------------------------------------------
   Extract endpoint details with methods and parameters
--------------------------------------------- */
function extractEndpointDetails(swaggerData) {
  const endpoints = [];
  const paths = swaggerData.paths || {};
  const components = swaggerData.components || {};
  const schemas = components.schemas || {};
  const securitySchemes = components.securitySchemes || {};

  for (const path in paths) {
    const pathItem = paths[path];
    const methods = ["get", "post", "put", "patch", "delete", "options", "head"];

    for (const method of methods) {
      if (pathItem[method]) {
        const operation = pathItem[method];
        const endpoint = {
          path: path,
          method: method.toUpperCase(),
          summary: operation.summary || "",
          description: operation.description || "",
          operationId: operation.operationId || "",
          tags: operation.tags || [],
          // Parameters organized by type for clarity
          parameters: {
            path: [],
            query: [],
            header: [],
            cookie: [],
            all: [],
          },
          // Request body with full schema and examples
          requestBody: null,
          responses: {},
          security: operation.security || swaggerData.security || [],
        };

        // Extract parameters (path, query, header, cookie) - VERY IMPORTANT FOR CLIENT
        if (operation.parameters && Array.isArray(operation.parameters)) {
          operation.parameters.forEach((param) => {
            const paramInfo = {
              name: param.name,
              in: param.in, // path, query, header, cookie
              required: param.required || false,
              description: param.description || "",
              deprecated: param.deprecated || false,
            };

            // Extract full schema details
            if (param.schema) {
              const resolvedSchema = resolveSchema(param.schema, schemas);
              paramInfo.schema = extractSchemaStructure(resolvedSchema || param.schema, schemas);
              paramInfo.type = paramInfo.schema?.type || param.schema?.type || "string";
              paramInfo.format = paramInfo.schema?.format || param.schema?.format;
              paramInfo.example = param.example || paramInfo.schema?.example || param.schema?.example;
              paramInfo.default = paramInfo.schema?.default || param.schema?.default;
              paramInfo.enum = paramInfo.schema?.enum || param.schema?.enum;
              paramInfo.minimum = paramInfo.schema?.minimum;
              paramInfo.maximum = paramInfo.schema?.maximum;
              paramInfo.minLength = paramInfo.schema?.minLength;
              paramInfo.maxLength = paramInfo.schema?.maxLength;
              paramInfo.pattern = paramInfo.schema?.pattern;
            } else {
              paramInfo.type = "string";
            }

            // Include style and explode for OpenAPI 3.0
            if (param.style) paramInfo.style = param.style;
            if (param.explode !== undefined) paramInfo.explode = param.explode;

            // Organize by parameter location
            endpoint.parameters.all.push(paramInfo);
            if (param.in === "path") {
              endpoint.parameters.path.push(paramInfo);
            } else if (param.in === "query") {
              endpoint.parameters.query.push(paramInfo);
            } else if (param.in === "header") {
              endpoint.parameters.header.push(paramInfo);
            } else if (param.in === "cookie") {
              endpoint.parameters.cookie.push(paramInfo);
            }
          });
        }

        // Extract request body if present - VERY IMPORTANT FOR CLIENT
        if (operation.requestBody) {
          const requestBodyContent = operation.requestBody.content || {};
          const contentTypes = Object.keys(requestBodyContent);
          
          // Support multiple content types with full details
          endpoint.requestBody = {
            required: operation.requestBody.required || false,
            description: operation.requestBody.description || "",
            contentTypes: {},
            // Generate example request body for easier testing
            example: null,
          };

          for (const contentType of contentTypes) {
            const contentSchema = requestBodyContent[contentType]?.schema;
            if (contentSchema) {
              const resolvedSchema = resolveSchema(contentSchema, schemas);
              const fullSchema = extractSchemaStructure(resolvedSchema || contentSchema, schemas);
              
              endpoint.requestBody.contentTypes[contentType] = {
                schema: fullSchema,
                example: requestBodyContent[contentType]?.example,
                examples: requestBodyContent[contentType]?.examples,
                // Generate example from schema if no example provided
                generatedExample: requestBodyContent[contentType]?.example 
                  ? null 
                  : generateMockFromSchema(resolvedSchema || contentSchema, schemas),
              };

              // Set primary example (prefer provided example, fallback to generated)
              if (!endpoint.requestBody.example && contentType === "application/json") {
                endpoint.requestBody.example = requestBodyContent[contentType]?.example 
                  || generateMockFromSchema(resolvedSchema || contentSchema, schemas);
              }
            } else {
              endpoint.requestBody.contentTypes[contentType] = {
                schema: null,
                example: requestBodyContent[contentType]?.example,
                examples: requestBodyContent[contentType]?.examples,
                generatedExample: null,
              };
            }
          }
        }

        // Extract responses
        if (operation.responses) {
          for (const [statusCode, response] of Object.entries(operation.responses)) {
            endpoint.responses[statusCode] = {
              description: response.description || "",
              content: {},
            };

            if (response.content) {
              for (const [contentType, content] of Object.entries(response.content)) {
                const responseSchema = content.schema;
                if (responseSchema) {
                  const resolvedSchema = resolveSchema(responseSchema, schemas);
                  endpoint.responses[statusCode].content[contentType] = {
                    schema: extractSchemaStructure(resolvedSchema || responseSchema, schemas),
                    example: content.example,
                    examples: content.examples,
                  };
                } else {
                  endpoint.responses[statusCode].content[contentType] = {
                    schema: null,
                    example: content.example,
                    examples: content.examples,
                  };
                }
              }
            }

            // Include headers in response
            if (response.headers) {
              endpoint.responses[statusCode].headers = {};
              for (const [headerName, header] of Object.entries(response.headers)) {
                endpoint.responses[statusCode].headers[headerName] = {
                  description: header.description || "",
                  schema: header.schema ? extractSchemaStructure(header.schema, schemas) : null,
                  required: header.required || false,
                };
              }
            }
          }
        }

        // Add summary for quick reference - VERY IMPORTANT FOR CLIENT
        endpoint.summary = {
          hasParameters: endpoint.parameters.all.length > 0,
          hasRequestBody: endpoint.requestBody !== null,
          parameterCount: {
            path: endpoint.parameters.path.length,
            query: endpoint.parameters.query.length,
            header: endpoint.parameters.header.length,
            cookie: endpoint.parameters.cookie.length,
            total: endpoint.parameters.all.length,
          },
          requiredParameters: endpoint.parameters.all.filter(p => p.required).map(p => ({
            name: p.name,
            in: p.in,
            type: p.type,
          })),
          requestBodyRequired: endpoint.requestBody?.required || false,
          requestBodyContentTypes: endpoint.requestBody ? Object.keys(endpoint.requestBody.contentTypes) : [],
          responseStatusCodes: Object.keys(endpoint.responses),
        };

        endpoints.push(endpoint);
      }
    }
  }

  return endpoints;
}

/* ---------------------------------------------
   Endpoint: Load Swagger URL (called by Flutter panel)
--------------------------------------------- */
app.post("/load-swagger", async (req, res) => {
  const { url } = req.body;
  const page = parseInt(req.query.page) || parseInt(req.body.page) || 1;
  const limit = parseInt(req.query.limit) || parseInt(req.body.limit) || 50;

  if (!url) return res.status(400).json({ message: "Swagger URL is required" });

  try {
    const result = await axios.get(url);
    swaggerData = result.data;

    setupMocks();

    const allEndpoints = extractEndpointDetails(swaggerData);
    const totalEndpoints = allEndpoints.length;
    const totalPages = Math.ceil(totalEndpoints / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedEndpoints = allEndpoints.slice(startIndex, endIndex);

    const protocol = req.get("x-forwarded-proto") || req.protocol;
    const baseUrl = `${protocol}://${req.get("host")}`;

    // Extract security schemes for client reference
    const securitySchemes = swaggerData.components?.securitySchemes || {};
    
    // Extract server information
    const servers = swaggerData.servers || [];

    return res.json({
      message: "Mock API created successfully",
      info: {
        title: swaggerData.info?.title || "",
        description: swaggerData.info?.description || "",
        version: swaggerData.info?.version || "",
      },
      pagination: {
        page: page,
        limit: limit,
        total: totalEndpoints,
        totalPages: totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
      endpoints: paginatedEndpoints,
      mockBaseUrl: baseUrl,
      securitySchemes: securitySchemes,
      servers: servers,
    });
  } catch (err) {
    return res.status(500).json({
      message: "Failed to load Swagger",
      error: err.message,
    });
  }
});

/* ---------------------------------------------
   Endpoint: Get all endpoints with pagination
--------------------------------------------- */
app.get("/endpoints", (req, res) => {
  if (!swaggerData || !swaggerData.paths) {
    return res.status(404).json({
      message: "No Swagger data loaded. Please call /load-swagger first.",
    });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const method = req.query.method ? req.query.method.toUpperCase() : null;
  const tag = req.query.tag || null;

  let allEndpoints = extractEndpointDetails(swaggerData);

  // Filter by method if provided
  if (method) {
    allEndpoints = allEndpoints.filter((ep) => ep.method === method);
  }

  // Filter by tag if provided
  if (tag) {
    allEndpoints = allEndpoints.filter((ep) => ep.tags.includes(tag));
  }

  const totalEndpoints = allEndpoints.length;
  const totalPages = Math.ceil(totalEndpoints / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;
  const paginatedEndpoints = allEndpoints.slice(startIndex, endIndex);

  return res.json({
    pagination: {
      page: page,
      limit: limit,
      total: totalEndpoints,
      totalPages: totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
    endpoints: paginatedEndpoints,
  });
});

/* ---------------------------------------------
   Start server (Render uses process.env.PORT)
--------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Mock server running on port ${PORT}`);
});
