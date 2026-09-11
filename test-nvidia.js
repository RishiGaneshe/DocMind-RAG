import { generateAnswer } from './src/services/llmService.js'

async function run() {
  try {
    console.log('🤖 Testing NVIDIA LLM generation...')
    console.log('Sending query: "How to apply for leave?"\n')
    
    const query = 'How to apply for leave?'
    const contextChunks = [
      'To apply for leave, log into the HR portal and click on Leave Management. Next, select Leave Request and choose the leave type (casual, sick, or earned). Enter the start and end dates along with a brief reason, then submit for manager approval. Approval usually takes 24 hours.'
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
