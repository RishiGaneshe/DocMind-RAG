# DocMind-RAG

This is a complete, scalable Retrieval-Augmented Generation (RAG) backend application. It allows users to register, create isolated workspaces (tenants), upload PDF documents, and query those documents using natural language. 

The system extracts text from the PDFs, generates vector embeddings locally using Ollama, stores them in Pinecone, and uses the Groq API (Llama 3) to generate accurate, context-aware answers based strictly on the uploaded documents.

## Technology Stack & Architecture

- **Backend Framework**: Node.js with Express.js
- **Database (Relational)**: PostgreSQL (Hosted on Neon) using Sequelize ORM
- **Caching & State**: Redis (Running via Docker)
- **Vector Database**: Pinecone 
- **Embedding Model**: Local `nomic-embed-text` running via Ollama (Dockerized)
- **LLM Provider**: Groq API (`llama-3.3-70b-versatile`)
- **Deployment**: Fully containerized using Docker & Docker Compose, deployed via GitHub Actions CI/CD to AWS EC2, and served via an Nginx Reverse Proxy with SSE support.

## Core Features

1. **User Authentication**: JWT-based authentication with access and refresh tokens.
2. **Multi-Tenancy**: Data isolation using Workspaces (Tenants).
3. **Document Processing pipeline**: 
   - Accepts PDF uploads up to 20MB.
   - Extracts and chunks text.
   - Generates vector embeddings locally using Ollama.
   - Upserts vectors and metadata into Pinecone.
4. **Intelligent Querying**:
   - Accepts natural language questions.
   - Retrieves relevant document chunks.
   - Supports **Server-Sent Events (SSE)** for real-time streaming responses.

## API Endpoints

### Authentication Endpoints
- `POST /api/auth/signup` - Registers a new user.
- `POST /api/auth/login` - Authenticates user and returns tokens.
- `POST /api/auth/refresh` - Issues a new access token.
- `POST /api/auth/logout` - Invalidates the current tokens.
- `GET /api/auth/me` - Fetches the authenticated user's profile.

### Workspace (Tenant) Endpoints
- `POST /api/tenants/` - Creates a new isolated workspace.
- `GET /api/tenants/me` - Retrieves the current user's workspace details.

### Document Endpoints
- `POST /api/tenants/:tenantId/documents/` - Uploads a PDF (multipart form), extracts text, embeds, and stores in Pinecone.
- `GET /api/tenants/:tenantId/documents/` - Lists all documents for a specific workspace.

### Query Endpoints
- `POST /api/tenants/:tenantId/query` - Queries the documents. Pass `stream: true` in the body to receive the response via Server-Sent Events (SSE).

## Local Development Setup

1. **Clone the repository**
2. **Configure Environment Variables**: Duplicate `.env.example` to `.env` and fill in your Pinecone, Neon DB, and Groq API keys. Ensure `REDIS_URL` points to your Redis instance.
3. **Run with Docker Compose**:
   ```bash
   docker compose up -d --build
   ```
   *This will start your Redis container, start the Ollama container (and automatically download the `nomic-embed-text` model), and run the Node.js application.*

## Production Deployment

The project includes a `.github/workflows/deploy.yml` pipeline. Upon pushing to the `develop` branch, the GitHub Action automatically connects to your configured AWS EC2 server, transfers the code, and builds/restarts the Docker containers seamlessly. An Nginx reverse proxy configuration is provided (`nginx.conf`) to serve the API over HTTPS while explicitly supporting SSE streaming.
