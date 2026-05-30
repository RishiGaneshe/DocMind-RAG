# Multi-Tenant RAG System with PGVector and Security Guardrails

This is a secure, high-performance multi-tenant Retrieval-Augmented Generation (RAG) system using Node.js, Express, PostgreSQL, and PGVector.

## Project Structure

```
project/
├── src/
│   ├── app.js               # Application entry point & Express configuration
│   ├── config.js            # Environment configuration and validation
│   ├── api/                 # API controllers and Express routers
│   │   ├── health.js        # Health check endpoints
│   │   ├── tenant.js        # Tenant management routes
│   │   └── document.js      # Document upload and RAG query routes
│   ├── services/            # Core business logic services
│   │   ├── db.js            # PostgreSQL connection & pool management
│   │   ├── tenantService.js # Tenant creation and management logic
│   │   ├── documentService.js # File processing, chunking & extraction logic
│   │   ├── llmService.js      # Prompt compilation, guardrails & LLM inference
│   │   └── embeddingService.js # Vector embedding generation
│   ├── middleware/          # Express request/response middlewares
│   │   ├── errorHandler.js  # Global error boundary and logging
│   │   ├── validator.js     # Request validation (tenant ID existence, etc.)
│   │   └── guardrails.js    # Security middleware (prompt injection check, etc.)
│   ├── rag/                 # RAG orchestrator & vector store interfaces
│   │   ├── vectorStore.js   # Cosine similarity queries with strict tenant filters
│   │   └── ragEngine.js     # Orchestrates document retrieval and answering
│   ├── models/              # Database schema definitions and SQL scripts
│   │   └── schema.sql       # Database table creation with PGVector
│   └── tests/               # Integrated test suites (Supertest + Jest)
│       ├── tenant.test.js
│       ├── document.test.js
│       └── guardrails.test.js
├── README.md                # System documentation
├── docker-compose.yml       # Docker compose for PostgreSQL + pgvector
├── .env.example             # Template for configuration environment variables
└── package.json             # NPM dependencies and scripts
```
"# DocMind-RAG" 
