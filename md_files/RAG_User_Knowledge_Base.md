# DocMind RAG Platform - User Journey & Feature Knowledge Base

This document provides a comprehensive, step-by-step guide to all user-facing features and workflows available in the DocMind Retrieval-Augmented Generation (RAG) platform. It serves as the primary source of truth for understanding how users interact with the system.

---

## Feature: User Registration (Sign Up)

**Purpose:**
Allows new users to create an account to access the DocMind platform.

**How to Access:**
Navigate to the `/signup.html` page, or click the "Sign up" link at the bottom of the Sign In page.

**Prerequisites:**
- The user must not already be logged into an active account. If they are, they will be automatically redirected to their workspace or the setup page.

**Steps:**
1. Open the "Create Account" page.
2. Fill in the "First name" and "Last name" fields.
3. Enter a valid email address in the "Email address" field.
4. Enter a secure password in the "Password" field. As you type, a password strength meter will indicate the strength (Weak, Fair, Good, Strong).
5. Re-enter the password in the "Confirm password" field to ensure they match.
6. Click the "Create Account" button.

**Required Information:**
- First name
- Last name
- Email address (must be a valid format)
- Password (minimum 8 characters)
- Password confirmation (must exactly match the password)

**Available Actions:**
- **Submit:** Click "Create Account" to register.
- **Navigate:** Click "Sign in" to go to the login page if an account already exists.

**Expected Result:**
- Upon successful registration, the system creates the account, authenticates the user, and redirects them to the Workspace Setup page (`/tenant-setup.html`).

**Next Steps:**
- Proceed to set up a new workspace (tenant).

**Restrictions / Important Notes:**
- Password must be at least 8 characters long.
- The UI provides real-time validation for email formatting and password matching.
- If an error occurs (e.g., email already in use), a red error banner will appear at the top of the form with the failure reason.

---

## Feature: User Login (Sign In)

**Purpose:**
Authenticates returning users so they can access their workspace and documents.

**How to Access:**
Navigate to the `/login.html` page, or click "Sign in" from the registration page. It is also the default landing page for unauthenticated users.

**Prerequisites:**
- The user must have previously registered an account.

**Steps:**
1. Open the "Sign In" page.
2. Enter the registered email address in the "Email address" field.
3. Enter the corresponding password in the "Password" field.
4. Click the "Sign In" button.

**Required Information:**
- Email address
- Password

**Available Actions:**
- **Submit:** Click "Sign In" to authenticate.
- **Navigate:** Click "Sign up" to go to the registration page if an account is needed.
- **Use Demo Credentials:** The UI displays a "Demo Credentials" hint block (admin@gmail.com / Admin@123) for quick access if configured in the environment.

**Expected Result:**
- If the user has already set up a workspace, they are redirected to the main dashboard (`/index.html`).
- If the user has not yet set up a workspace, they are redirected to the Workspace Setup page (`/tenant-setup.html`).

**Next Steps:**
- Begin uploading documents or chatting with the AI (if workspace exists).
- Set up a workspace (if one does not exist).

**Restrictions / Important Notes:**
- If authentication fails, a red error banner will display a message such as "Invalid email or password."
- The system checks for an existing active session on load and auto-redirects authenticated users.

---

## Feature: Workspace Creation (Tenant Setup)

**Purpose:**
Creates a dedicated workspace (tenant) for the user's organization where documents and AI conversations will be securely stored.

**How to Access:**
Users are automatically redirected to `/tenant-setup.html` after a successful sign-up or after logging in if they don't already have a workspace.

**Prerequisites:**
- The user must be logged in.
- The user must not already belong to an existing workspace.

**Steps:**
1. Observe the welcome message confirming your first name.
2. Enter your organization's name in the "Organization / Workspace Name" field.
3. Observe the "Workspace URL Slug" field, which auto-generates a slug based on the organization name.
4. (Optional) Manually edit the "Workspace URL Slug" if a different identifier is preferred.
5. Review the "Slug Preview" box below the input to see how the final URL might look (e.g., `your-workspace.docmind.ai`).
6. Click the "Create Workspace" button.

**Required Information:**
- Organization / Workspace Name
- Workspace URL Slug (auto-generated, but can be modified)

**Available Actions:**
- **Edit Slug:** Manually adjust the auto-generated slug.
- **Submit:** Click "Create Workspace" to finalize.

**Expected Result:**
- The system creates the tenant and assigns the user to it.
- Fresh authentication tokens are issued containing the new tenant ID.
- The user is redirected to the main application dashboard (`/index.html`).

**Next Steps:**
- Start using the main application by uploading documents.

**Restrictions / Important Notes:**
- The Slug must be at least 3 characters long.
- The Slug must contain only lowercase letters, numbers, and hyphens.
- The Slug must start and end with a letter or number (no trailing/leading hyphens).
- Error messages will be displayed in a red banner if the creation fails (e.g., slug already taken).

---

## Feature: Upload Document

**Purpose:**
Allows users to upload PDF documents into their workspace to be processed and indexed by the AI for semantic search and Q&A.

**How to Access:**
Located in the left sidebar of the main dashboard (`/index.html`) under the "Upload Document" section.

**Prerequisites:**
- The user must be logged in and have an active workspace.

**Steps:**
1. Locate the dashed "drop zone" box in the left sidebar.
2. **Option A (Drag & Drop):** Drag a PDF file from your computer and drop it into the dashed box.
3. **Option B (Browse):** Click anywhere inside the drop zone or click the bold "browse" text to open your system's file picker, then select a PDF file.
4. Wait for the upload process to finish. A progress bar will appear showing the file name and the status ("Processing" -> "Completed").

**Required Information:**
- A valid PDF file.

**Available Actions:**
- **Drag & Drop:** Drop files directly into the UI.
- **Browse:** Open the system file dialog.

**Expected Result:**
- The document is uploaded and processed into chunks by the server.
- The progress bar turns green and indicates "Completed".
- A green success toast notification appears in the top right corner confirming the upload and the number of chunks processed.
- The "Your Documents" list automatically refreshes to include the newly uploaded file.

**Next Steps:**
- Upload more documents.
- Ask questions about the uploaded document in the chat area.

**Restrictions / Important Notes:**
- **File Type:** Only `.pdf` (application/pdf) files are supported. Uploading other formats will result in an error toast.
- **File Size limit:** The UI text suggests a 1 MB limit ("PDF files up to 1 MB only"), however, both the frontend validation and backend configuration enforce a maximum limit of 10 MB. Files exceeding 10 MB will be blocked.
- **Deduplication:** Uploading an identical PDF (matching content hash) bypasses processing and immediately returns the existing document.
- The user cannot cancel the upload once it has started from the frontend UI.

---

## Feature: View Documents List

**Purpose:**
Displays a list of all documents currently uploaded to the user's workspace, along with their processing status.

**How to Access:**
Located in the left sidebar of the main dashboard (`/index.html`) under the "Your Documents" section.

**Prerequisites:**
- The user must be logged in and have an active workspace.

**Steps:**
1. Look at the "Your Documents" section in the sidebar.
2. If no documents exist, an "empty state" message will instruct you to upload a PDF.
3. If documents exist, scroll through the list to view them.

**Required Information:**
- None (data is fetched automatically).

**Available Actions:**
- **View Status:** Observe the colored dot next to each document to understand its processing status.
- **Hover:** Hover over a document item to see the full filename if it is truncated.

**Expected Result:**
- Displays the filename, file size, total chunks processed, and a status indicator for each document.

**Status Indicators:**
- **Green Dot (Completed):** The document is fully processed and ready for querying.
- **Yellow Pulsing Dot (Processing):** The document is currently being chunked and indexed.
- **Red Dot (Failed):** The document failed to process.
- **Grey Dot (Pending):** The document is queued for processing.

**Next Steps:**
- Use the chat interface to query the completed documents.

**Restrictions / Important Notes:**
- There is currently no UI option to delete or rename documents directly from this list.

---

## Feature: Chat / Ask a Question (Semantic Search)

**Purpose:**
Allows users to ask natural language questions. The AI searches the uploaded documents, retrieves relevant context, and streams back an answer.

**How to Access:**
Located in the main content area of the dashboard (`/index.html`). The input box is pinned to the bottom of the screen.

**Prerequisites:**
- The user must be logged in.
- For meaningful answers, at least one document should be uploaded and successfully processed.

**Steps:**
1. Click into the text area labeled "Ask a question about your documents...".
2. Type your question or prompt. The text area will automatically expand if your question spans multiple lines.
3. **Submit the query:** Press the `Enter` key (without Shift) OR click the purple "Send" button (➤ icon) on the right side of the input box.
4. Wait for the AI to generate a response. A pulsing placeholder will appear while waiting.
5. Read the response as it streams onto the screen in real-time.

**Required Information:**
- A text query/question.

**Available Actions:**
- **Type Question:** Input text.
- **Multi-line Input:** Use `Shift + Enter` to create a new line without submitting.
- **Send:** Submit the question to the AI.

**Expected Result:**
- The user's message appears on the right side of the chat area.
- The "Welcome to DocMind" placeholder screen (if visible) disappears.
- The AI's response appears on the left side and types out progressively (streaming).
- Markdown formatting (bold, lists, code blocks) in the AI's response is properly rendered.
- If relevant documents were found, a "sources found" toggle appears below the AI's answer.

**Next Steps:**
- Ask follow-up questions.
- Click the sources toggle to verify where the AI got its information.

**Restrictions / Important Notes:**
- The Send button is disabled if the input box is empty or contains only whitespace.
- If a network error occurs during streaming, the AI message will display an error text in red, and a toast notification will appear.

---

## Feature: View Source Citations

**Purpose:**
Allows users to view the exact document snippets and relevance scores that the AI used to generate its answer, ensuring transparency and accuracy.

**How to Access:**
Appears automatically below an AI's chat response if the system found relevant document chunks for the user's query.

**Prerequisites:**
- The user must have successfully asked a question that triggered a document retrieval.

**Steps:**
1. Look immediately beneath a completed AI message for a button labeled "▸ [X] sources found" (where X is the number of sources).
2. Click the button to toggle the sources list open.
3. Review the individual source chips. Each chip displays a percentage score and a text snippet.
4. Click the toggle button again to hide the sources list.

**Required Information:**
- None.

**Available Actions:**
- **Expand/Collapse:** Click the sources toggle to show or hide the citations.

**Expected Result:**
- When expanded, displays a vertical list of source snippets.
- Each snippet shows a relevance score percentage.
  - **Green background:** High relevance (75% or higher).
  - **Yellow background:** Medium relevance (below 75%).

**Next Steps:**
- Use the provided context to verify the AI's claims.

**Restrictions / Important Notes:**
- The sources are read-only; you cannot click on them to open the original PDF at a specific page.

---

## Feature: User Profile & Logout

**Purpose:**
Displays current user identity and provides a secure way to end the session.

**How to Access:**
Located at the very bottom of the left sidebar on the main dashboard (`/index.html`).

**Prerequisites:**
- The user must be logged in.

**Steps to Logout:**
1. Locate the user section at the bottom of the sidebar.
2. Find the power icon (⏻) button on the right side of the user details box.
3. Click the button to sign out.

**Required Information:**
- None.

**Available Actions:**
- **View Profile Details:** See your generated avatar (first letter of name/email), email address, and workspace name.
- **Sign Out:** Click the logout button.

**Expected Result:**
- The system invalidates the active session and clears local authentication tokens.
- The user is immediately redirected to the Sign In page (`/login.html`).

**Next Steps:**
- The user must log in again to access the platform.

**Restrictions / Important Notes:**
- There is no dedicated profile editing page or settings menu accessible from this UI component; it is purely informational and for logging out.

---

## Feature: Mobile Navigation (Sidebar Toggle)

**Purpose:**
Allows users on mobile devices or smaller screens to hide or reveal the sidebar menu, maximizing screen space for the chat interface.

**How to Access:**
Available on the main dashboard (`/index.html`) when the browser window is narrow (typically mobile devices). Appears as a hamburger menu icon (☰) in the top-left corner of the screen.

**Prerequisites:**
- The user must be logged in.
- The screen width must be 768px or smaller.

**Steps:**
1. Click the hamburger menu icon (☰) in the top-left corner.
2. The sidebar will slide into view from the left side.
3. Click the icon again to close the sidebar.

**Required Information:**
- None.

**Available Actions:**
- **Toggle Sidebar:** Open or close the sidebar panel.

**Expected Result:**
- The sidebar smoothly transitions in and out of the viewport.

**Restrictions / Important Notes:**
- This button is hidden on desktop/larger screens where the sidebar is permanently visible.

---

## Feature: Advanced API & Developer Capabilities (Backend-Only)

**Purpose:**
Provides developers and administrators with programmatic access to DocMind functionalities that are currently not exposed via the graphical user interface. 

**Available Capabilities:**
- **API Key Management:** A suite of endpoints (`/api/tenants/:tenantId/api-keys`) exists to generate, list, update, rotate, and revoke API keys. These keys are scoped for specific actions (e.g., `chat:query`, `chat:filter`, `documents:read`).
- **Public Chat Widget Integration:** Users can embed a DocMind chat widget onto external websites. The configuration (`/api/tenants/:tenantId/widget`) dictates how sources are exposed to visitors (`full`, `labels`, or `hidden`).
- **Public Chat Endpoint:** A dedicated endpoint (`/api/public/chat`) accepts queries from anonymous users via the chat widget. It enforces rate limits (e.g. 10 requests/min for visitors), strict quotas, and origin validation to protect the tenant.
- **Document Deletion:** A `DELETE /api/tenants/:tenantId/documents/:documentId` endpoint allows developers to permanently delete a document, immediately wiping its chunks and vector embeddings (the UI currently has no delete button).
- **Advanced Query Parameters:** The chat API supports advanced options via payload parameters:
  - `documentIds`: Array of document UUIDs to restrict the AI's search context exclusively to those files.
  - `topK`: Controls the maximum number of retrieved document chunks used by the AI to formulate an answer (max 20).
  - `history`: Pass prior chat turns as context for multi-turn conversations (max 6 turns).
