-- Semantic search for Layer 2 (Conversation Memory) per
-- docs/spect/00_VISION/03-memory-engine.md §2/ADR-002 (pgvector chosen over
-- Qdrant/Pinecone). Layers 3-6 (Project/Company/Personal/Global Knowledge)
-- and the Neo4j Memory Graph are NOT part of this migration — see
-- docs/spect/DONE.md for what's deliberately out of scope.
--
-- Requires the pgvector extension to be installed in the Postgres image
-- (pgvector/pgvector:pg16 — see ONBOARDING.md). 768 dims matches
-- nomic-embed-text (this project's own dev/test embedding model, run
-- locally via Ollama); a different EMBEDDING_MODEL with a different
-- dimensionality would need a matching column-width migration.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE messages ADD COLUMN embedding vector(768);

-- hnsw over ivfflat: no need to pre-populate data for good clustering
-- before the index is useful, which matters for a table that starts empty.
CREATE INDEX idx_messages_embedding ON messages USING hnsw (embedding vector_cosine_ops);
