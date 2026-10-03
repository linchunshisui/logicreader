
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { readFileSync, writeFileSync } from 'node:fs'

const png = readFileSync('tests/fixtures/chart.png')
const pdf = await PDFDocument.create()
const font = await pdf.embedFont(StandardFonts.Helvetica)
const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
const image = await pdf.embedPng(png)

const titles = [
  'Deep Learning Survey: Attention Mechanisms',
  '2 Background and Motivation',
  '2.1 Recurrent Architectures',
  '3 Methodology',
  '4 Results and Discussion'
]
const body = [
  'This document is a synthetic fixture used to exercise the LogicReader PDF pipeline. It contains headings, paragraphs, a table, hyperlinks and an embedded raster image so that the smart dark mode can be verified against image regions.',
  'Recurrent neural networks process sequences step by step. The hidden state carries information forward, but the sequential dependency limits parallelisation and makes long range dependencies difficult to learn.',
  'We argue that the introduction of attention is a structural simplification of sequence dependency modelling. Instead of compressing the past into a fixed vector, the model attends to every position directly.',
  'The proposed method reaches 28.4 BLEU on the English to German task, an improvement of 2.1 points over the recurrent baseline. Training used eight accelerators for three days.',
  'In conclusion, attention mechanisms replace recurrence with direct pairwise interaction, which improves both accuracy and training throughput.'
]

const pages = []
for (let p = 0; p < 5; p += 1) {
  const page = pdf.addPage([595, 842])
  pages.push(page)
  page.drawText(titles[p], { x: 56, y: 770, size: p === 0 ? 20 : 16, font: bold, color: rgb(0.1, 0.1, 0.12) })
  page.drawLine({ start: { x: 56, y: 756 }, end: { x: 539, y: 756 }, thickness: 0.8, color: rgb(0.75, 0.75, 0.78) })
  let y = 720
  for (let i = 0; i < 5; i += 1) {
    const text = body[(p + i) % body.length]
    const words = text.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(candidate, 11) > 470) {
        page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.15, 0.15, 0.18) })
        y -= 15
        line = word
      } else {
        line = candidate
      }
    }
    if (line) { page.drawText(line, { x: 56, y, size: 11, font, color: rgb(0.15, 0.15, 0.18) }); y -= 15 }
    y -= 8
  }
  if (p === 2) {
    page.drawImage(image, { x: 120, y: 220, width: 360, height: 205 })
    page.drawText('Figure 3: quarterly revenue by product line (embedded raster image)', { x: 120, y: 200, size: 9, font, color: rgb(0.35, 0.35, 0.4) })
  }
}

pdf.setTitle('Deep Learning Survey (test fixture)')
const bytes = await pdf.save()
writeFileSync('tests/fixtures/survey.pdf', bytes)
console.log('pdf written', bytes.length)
