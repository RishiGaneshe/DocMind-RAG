import { generateAnswer } from './src/services/llmService.js'

async function run() {
  try {
    console.log('🤖 Testing NVIDIA LLM generation...')
    console.log('Sending query: "What is the capital of France?"\n')
    
    const query = 'What is the capital of France?'
    const contextChunks = [
      'The capital of France is Paris, a major European city known for its art, gastronomy, and culture.'
    ]
    
    const answer = await generateAnswer(query, contextChunks)
    
    console.log('✅ Response received successfully:\n')
    console.log(answer)
    console.log('\n✅ NVIDIA Integration is working perfectly!')
  } catch (error) {
    console.error('\n❌ Failed to generate answer:', error)
  }
}

run()
