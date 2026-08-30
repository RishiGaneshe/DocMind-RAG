import { describe, it } from 'node:test'

// Marked todo rather than asserting `true === true`: a placeholder that reports
// green is worse than one that reports honestly. Exercising these routes needs
// a Postgres and a Pinecone namespace fixture.
describe('Document API', () => {
  it('rejects a non-PDF upload', { todo: 'needs an HTTP + database fixture' })
  it('stores chunk rows alongside vectors', { todo: 'needs an HTTP + database fixture' })
})
