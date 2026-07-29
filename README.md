# DocMind-RAG

DocMind-RAG is a scalable **Retrieval-Augmented Generation (RAG) backend application** that enables users to create isolated workspaces (tenants), upload PDF documents, and query their documents using natural language.

The system extracts and chunks text from uploaded PDFs, generates vector embeddings using **Voyage AI**, stores the embeddings in **Pinecone**, performs semantic similarity search to retrieve relevant document context, and uses the **Groq API** with Llama 3 to generate accurate, context-aware responses based on the uploaded documents.

## Technology Stack & Architecture

- **Backend Framework**: Node.js with Express.js
- **Database (Relational)**: PostgreSQL using Sequelize ORM
- **Caching & State**: Redis
- **Vector Database**: Pinecone
- **Embedding Provider**: Voyage AI
- **Embedding Model**: `voyage-4`
- **Embedding Dimensions**: 1024
- **Similarity Metric**: Cosine Similarity
- **LLM Provider**: Groq API (`llama-3.3-70b-versatile`)
- **Containerization**: Docker & Docker Compose
- **CI/CD**: GitHub Actions
- **Cloud Deployment**: AWS EC2
- **Reverse Proxy**: Nginx with HTTPS and SSE support

## RAG Architecture

The application follows a multi-stage RAG pipeline:

```text
PDF Upload
    ↓
Text Extraction
    ↓
Text Chunking
    ↓
Voyage AI Embeddings
    ↓
Pinecone Vector Storage
    ↓
Semantic Search
    ↓
Relevant Context Retrieval
    ↓
Groq LLM
    ↓
Context-Aware Answer
```

### Document Embedding Pipeline

Uploaded documents are processed and split into smaller chunks before being sent to Voyage AI.

The application uses the `voyage-4` embedding model with **1024-dimensional vectors**.

Instead of sending a separate HTTP request for every document chunk, chunks are grouped into batches and sent to Voyage AI using its batch embedding capability.

```text
Document Chunks
      ↓
Batch Processing
      ↓
20 chunks per batch
      ↓
Single Voyage AI API Request
      ↓
20 Embedding Vectors
      ↓
Pinecone
```

This reduces unnecessary HTTP requests and improves the efficiency of document ingestion.

Document chunks are embedded using:

```text
input_type: document
```

while user search queries are embedded using:

```text
input_type: query
```

This allows Voyage AI to optimize the generated vectors for retrieval-based workloads.

## Core Features

1. **User Authentication**
   - JWT-based authentication.
   - Access and refresh token support.
   - Secure logout and token invalidation.

2. **Multi-Tenancy**
   - Workspace-based tenant architecture.
   - Documents and queries are isolated between tenants.
   - Tenant-specific vector retrieval.

3. **Document Processing Pipeline**
   - Accepts PDF uploads up to 20 MB.
   - Extracts text from uploaded PDFs.
   - Splits extracted content into manageable chunks.
   - Processes chunks using batch embedding.
   - Generates 1024-dimensional embeddings using Voyage AI `voyage-4`.
   - Stores vectors and associated metadata in Pinecone.

4. **Semantic Search**
   - Converts user questions into query embeddings using Voyage AI.
   - Performs cosine similarity search against document vectors stored in Pinecone.
   - Retrieves the most semantically relevant document chunks.

5. **RAG-Based Answer Generation**
   - Relevant chunks retrieved from Pinecone are supplied as context to the LLM.
   - Groq's `llama-3.3-70b-versatile` model generates answers based on the retrieved document context.

6. **Streaming Responses**
   - Supports **Server-Sent Events (SSE)**.
   - Allows generated responses to be streamed to clients in real time.

7. **Resilient Embedding Pipeline**
   - Request timeout handling.
   - Automatic retries for transient API failures.
   - Exponential retry backoff.
   - Rate-limit handling.
   - Batch failure handling.
   - Preserves chunk-to-embedding alignment when failures occur.

## API Endpoints

### Authentication Endpoints

- `POST /api/auth/signup` - Registers a new user.
- `POST /api/auth/login` - Authenticates a user and returns authentication tokens.
- `POST /api/auth/refresh` - Issues a new access token.
- `POST /api/auth/logout` - Invalidates the current authentication tokens.
- `GET /api/auth/me` - Fetches the authenticated user's profile.

### Workspace (Tenant) Endpoints

- `POST /api/tenants/` - Creates a new isolated workspace.
- `GET /api/tenants/me` - Retrieves the current user's workspace details.

### Document Endpoints

- `POST /api/tenants/:tenantId/documents/` - Uploads a PDF, extracts and chunks its text, generates embeddings using Voyage AI, and stores the resulting vectors in Pinecone.
- `GET /api/tenants/:tenantId/documents/` - Lists all documents belonging to a specific workspace.

### Query Endpoints

- `POST /api/tenants/:tenantId/query` - Queries documents belonging to a workspace.

Pass:

```json
{
  "stream": true
}
```

to receive the generated response through **Server-Sent Events (SSE)**.

## Local Development Setup

### 1. Clone the Repository

Clone the repository and navigate into the project directory.

### 2. Configure Environment Variables

Duplicate `.env.example` as `.env` and configure the required credentials.

Required services include:

- PostgreSQL
- Redis
- Pinecone
- Voyage AI
- Groq

Example:

```env
DATABASE_URL=postgresql://postgres:postgres123@postgres:5432/rag_db
REDIS_URL=redis://redis:6379
VOYAGE_API_KEY=your_voyage_api_key
PINECONE_API_KEY=your_pinecone_api_key
GROQ_API_KEY=your_groq_api_key
```

Never commit the `.env` file or production API keys to the repository.

### 3. Run with Docker Compose

```bash
docker compose up -d --build
```

Docker Compose starts the application infrastructure including:

- Node.js RAG backend
- PostgreSQL
- Redis

Embedding generation is handled remotely through the Voyage AI API, so no local embedding model or GPU-intensive embedding container is required.

### 4. Verify Running Containers

```bash
docker compose ps
```

The RAG stack should contain services similar to:

```text
rag-app
rag-postgres
rag-redis
```

## Vector Database Configuration

Pinecone should be configured to match the Voyage embedding configuration.

```text
Dimension: 1024
Metric: cosine
Embedding Model: voyage-4
```

The vector dimensions produced by the embedding model must match the dimensions configured for the Pinecone index.

Existing vectors generated using a different embedding model should not be mixed with Voyage AI vectors in the same index.

If the embedding model or vector dimensions are changed, existing documents should be re-embedded using the new model before they are used for semantic retrieval.

## Production Deployment

The project includes a GitHub Actions deployment pipeline located at:

```text
.github/workflows/deploy.yml
```

When changes are pushed to the configured deployment branch, GitHub Actions automatically connects to the AWS EC2 instance, deploys the latest application code, and rebuilds/restarts the Docker services.

The production architecture is:

```text
Client
   ↓
HTTPS
   ↓
Nginx Reverse Proxy
   ↓
Node.js / Express API
   │
   ├── PostgreSQL
   ├── Redis
   ├── Voyage AI
   ├── Pinecone
   └── Groq API
```

Nginx is configured to support long-lived **Server-Sent Events (SSE)** connections used for streaming RAG responses.

## Production RAG Flow

```text
User uploads PDF
        ↓
PDF text extraction
        ↓
Text chunking
        ↓
Batch chunks
        ↓
Voyage AI
(voyage-4 / document)
        ↓
1024-dimensional vectors
        ↓
Pinecone

----------------------------

User submits question
        ↓
Voyage AI
(voyage-4 / query)
        ↓
Query vector
        ↓
Pinecone cosine similarity search
        ↓
Relevant document chunks
        ↓
Groq LLM
(llama-3.3-70b-versatile)
        ↓
Context-aware response
        ↓
SSE stream to client
```
