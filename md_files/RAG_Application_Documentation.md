# Retrieval-Augmented Generation (RAG) Application Documentation

## 1. Project Overview
This project is a complete, scalable Retrieval-Augmented Generation (RAG) backend application. It allows users to register, create isolated workspaces (tenants), upload PDF documents, and query those documents using natural language. The system extracts text from the PDFs, generates vector embeddings, stores them in a vector database, and uses a Large Language Model (LLM) to generate accurate, context-aware answers based strictly on the uploaded documents.

## 2. Technology Stack & Architecture
- **Backend Framework**: Node.js with Express.js
- **Database (Relational)**: PostgreSQL (Hosted on Neon) using Sequelize ORM for user and tenant management.
- **Caching & State**: Redis (Running via Docker) for token management and rate limiting.
- **Vector Database**: Pinecone for storing and performing similarity searches on document embeddings.
- **Embedding Model**: Local `nomic-embed-text` running via Ollama in Docker.
- **LLM Provider**: Groq API (using `llama-3.3-70b-versatile`) for high-speed answer generation.
- **Infrastructure & Deployment**: Docker, Docker Compose, GitHub Actions (CI/CD) deployed to an AWS EC2 Ubuntu instance with an Nginx reverse proxy.

## 3. Core Features
1. **User Authentication**: Secure JWT-based authentication with access and refresh tokens.
2. **Multi-Tenancy**: Data isolation using Workspaces (Tenants). Users can only access and query documents within their specific workspace.
3. **Document Processing pipeline**: 
   - Accepts PDF uploads.
   - Extracts and chunks text.
   - Generates vector embeddings locally using Ollama.
   - Upserts vectors and metadata into Pinecone.
4. **Intelligent Querying**:
   - Accepts natural language questions.
   - Performs semantic search against Pinecone to retrieve the most relevant document chunks.
   - Passes context to Groq to generate a final answer.
   - Supports **Server-Sent Events (SSE)** for real-time streaming responses.

---

## 4. API Endpoints

### 4.1 Authentication Endpoints (`/api/auth`)
- **`POST /api/auth/signup`**
  - **Body**: `{ "email": "...", "password": "...", "firstName": "...", "lastName": "..." }`
  - **Description**: Registers a new user and returns JWT tokens.
- **`POST /api/auth/login`**
  - **Body**: `{ "email": "...", "password": "..." }`
  - **Description**: Authenticates user and returns JWT tokens.
- **`POST /api/auth/refresh`**
  - **Body**: `{ "refreshToken": "..." }`
  - **Description**: Issues a new access token.
- **`POST /api/auth/logout`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Description**: Invalidates the current tokens.
- **`GET /api/auth/me`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Description**: Fetches the authenticated user's profile.

### 4.2 Workspace (Tenant) Endpoints (`/api/tenants`)
- **`POST /api/tenants/`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Body**: `{ "name": "My Workspace", "slug": "my-workspace" }`
  - **Description**: Creates a new isolated workspace.
- **`GET /api/tenants/me`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Description**: Retrieves the current user's workspace details.

### 4.3 Document Endpoints (`/api/tenants/:tenantId/documents`)
- **`POST /api/tenants/:tenantId/documents/`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Body**: `multipart/form-data` containing a `file` (PDF).
  - **Description**: Uploads a PDF, processes it, generates embeddings via Ollama, and stores them in Pinecone.
- **`GET /api/tenants/:tenantId/documents/`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Description**: Lists all documents uploaded to the specific workspace.

### 4.4 Query Endpoints (`/api/tenants/:tenantId/query`)
- **`POST /api/tenants/:tenantId/query`**
  - **Headers**: `Authorization: Bearer <token>`
  - **Body**: `{ "query": "What is the summary of the uploaded document?", "stream": true, "topK": 5 }`
  - **Description**: Queries the uploaded documents. If `stream: true` is passed, the response is sent via Server-Sent Events (SSE) for real-time typing effect.

---

## 5. Deployment & CI/CD Pipeline
The application utilizes a robust deployment strategy:
1. **GitHub Actions**: A `.github/workflows/deploy.yml` pipeline triggers on push to the `develop` branch.
2. **Docker Compose**: The application is fully containerized. The `docker-compose.yml` spins up:
   - **rag-redis**: Redis cache.
   - **rag-ollama**: Local embedding server pulling `nomic-embed-text`.
   - **rag-app**: The core Node.js application.
3. **Nginx Reverse Proxy**: Located on the AWS EC2 instance, Nginx securely routes traffic from `rag.docmind.codewithrishi.fun` to the Node app on port 4500. The Nginx configuration explicitly disables buffering to perfectly support SSE streaming responses.
