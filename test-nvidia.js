import { llmConfig } from './src/config.js'
import { generateAnswer } from './src/services/llmService.js'

async function run() {
  try {
    console.log(`🤖 Testing NVIDIA LLM generation with model: [${llmConfig.model}]`)
    console.log('Sending query: "How to apply for leave?"\n')

    const query = 'How to apply for leave?'
    const contextChunks = [
      'To apply for leave, log into the HR portal and click on Leave Management. Next, select Leave Request and choose the leave type (casual, sick, or earned). Enter the start and end dates along with a brief reason, then submit for manager approval. Approval usually takes 24 hours.'
    ]

    const startTime = Date.now()
    const answer = await generateAnswer(query, contextChunks)
    const duration = Date.now() - startTime

    console.log(`✅ Response received successfully in ${duration} ms:\n`)
    console.log(answer)
    console.log('\n✅ NVIDIA Integration is working perfectly!')
  } catch (error) {
    console.error('\n❌ Failed to generate answer:', error)
  }
}

run()
