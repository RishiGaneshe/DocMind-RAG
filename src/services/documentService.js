import crypto from 'crypto'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

const CHUNK_SIZE = 400
const CHUNK_OVERLAP = 70


export const createChunks = ( text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP ) => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')

  const chunks = []

  let start = 0

  while (start < words.length) {
    const end = start + chunkSize

    chunks.push(
      words.slice(start, end).join(' ')
    )

    start += (chunkSize - overlap)
  }

  return chunks
}


const extractTextFromPdf = async (fileBuffer) => {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer)
  })

  const pdf = await loadingTask.promise

  let fullText = ''

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)

    const textContent =
      await page.getTextContent()

    const pageText = textContent.items
      .map(item => item.str)
      .join(' ')

    fullText += `${pageText}\n`
  }

  return {
    text: fullText,
    numPages: pdf.numPages
  }
}


export const processDocument = async ( fileBuffer, filename ) => {
  try {
    const { text, numPages } = await extractTextFromPdf( fileBuffer )

    const contentHash = crypto.createHash('sha256').update(fileBuffer).digest('hex')

    const chunks = createChunks( text, CHUNK_SIZE, CHUNK_OVERLAP )

    return {
      filename,
      contentHash,
      numPages,
      metadata: {
        chunkSize: CHUNK_SIZE,
        overlap: CHUNK_OVERLAP
      },
      chunks
    }

  } catch (error) {
    console.error(
      'Error processing document:',
      error
    )

    throw error
  }
}