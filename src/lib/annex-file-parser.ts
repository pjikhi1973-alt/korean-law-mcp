/**
 * 별표 파일 파서 (HWPX / HWP / PDF 분기)
 *
 * - HWPX (신형): hwpx-parser.ts로 파싱 (manifest 기반 멀티섹션, colSpan/rowSpan, 중첩 테이블)
 * - HWP (구형): hwp.js로 텍스트 추출 → Markdown
 * - PDF: 파싱 불가 → null (LLM이 직접 읽도록 링크 반환)
 *
 * HWPX 파서 참고: https://github.com/roboco-io/hwp2md
 */

import { createRequire } from "module"
import { parseHwpxDocument } from "./hwpx-parser.js"

const esmRequire = createRequire(import.meta.url)

// ─── 매직바이트 감지 ─────────────────────────────────

function isHwpxFile(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4))
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

function isOldHwpFile(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4))
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
}

function isPdfFile(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4))
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46
}

// ─── 공통 인터페이스 ─────────────────────────────────

export interface AnnexParseResult {
  success: boolean
  markdown?: string
  fileType: "hwpx" | "hwp" | "pdf" | "unknown"
  error?: string
}

// ─── 메인 엔트리 ─────────────────────────────────────

export async function parseAnnexFile(buffer: ArrayBuffer): Promise<AnnexParseResult> {
  if (isHwpxFile(buffer)) {
    return parseHwpx(buffer)
  }
  if (isOldHwpFile(buffer)) {
    return parseHwp(buffer)
  }
  if (isPdfFile(buffer)) {
    return { success: false, fileType: "pdf", error: "PDF 파일은 직접 파싱할 수 없습니다." }
  }
  return { success: false, fileType: "unknown", error: "지원하지 않는 파일 형식입니다." }
}

// ─── HWPX 파서 (hwpx-parser.ts 위임) ────────────────

async function parseHwpx(buffer: ArrayBuffer): Promise<AnnexParseResult> {
  try {
    const markdown = await parseHwpxDocument(buffer)
    return { success: true, fileType: "hwpx", markdown }
  } catch (err) {
    return { success: false, fileType: "hwpx", error: err instanceof Error ? err.message : "HWPX 파싱 실패" }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── HWP용 간이 Markdown 테이블 생성 ─────────────────

function createMarkdownTable(data: string[][]): string {
  if (data.length === 0) return ""
  const maxCols = Math.max(...data.map(row => row.length))
  const normalized = data.map(row => {
    const r = [...row]
    while (r.length < maxCols) r.push("")
    return r
  })

  const md: string[] = []
  md.push("| " + normalized[0].join(" | ") + " |")
  md.push("| " + normalized[0].map(() => "---").join(" | ") + " |")
  for (let i = 1; i < normalized.length; i++) {
    md.push("| " + normalized[i].join(" | ") + " |")
  }
  return md.join("\n")
}

// ─── 구형 HWP 파서 (hwp.js 사용) ────────────────────

async function parseHwp(buffer: ArrayBuffer): Promise<AnnexParseResult> {
  try {
    const hwpjs = esmRequire("hwp.js")
    const parse = hwpjs.parse
    const nodeBuffer = Buffer.from(buffer)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hwpDoc: any = parse(nodeBuffer, { type: "buffer" })

    if (!hwpDoc.sections || hwpDoc.sections.length === 0) {
      return { success: false, fileType: "hwp", error: "HWP 문서에 내용이 없습니다" }
    }

    /** content 배열에서 텍스트 추출 (한 글자씩 {type:0, value:"X"} 형태) */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function extractTextFromContent(content: any[]): string {
      let text = ""
      for (const item of content) {
        if (item.value !== undefined && typeof item.value === "string") {
          text += item.value
        }
        if (item.content && Array.isArray(item.content)) {
          text += extractTextFromContent(item.content)
        }
      }
      return text
    }

    /** items(단락) 배열에서 텍스트 추출 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function extractTextFromItems(items: any[]): string {
      const texts: string[] = []
      for (const item of items) {
        const content = item.content || []
        const text = extractTextFromContent(content).trim()
        if (text) texts.push(text)
      }
      return texts.join(" ")
    }

    /** controls 내 테이블 → Markdown 변환 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function extractTableFromControl(ctrl: any): string | null {
      if (!ctrl.content || !Array.isArray(ctrl.content) || !ctrl.rowCount) return null

      const rows: string[][] = []
      for (const row of ctrl.content) {
        if (!Array.isArray(row)) continue
        const cells: string[] = []
        for (const cell of row) {
          const items = cell.items || []
          cells.push(extractTextFromItems(items))
        }
        rows.push(cells)
      }

      if (rows.length === 0) return null
      return createMarkdownTable(rows)
    }

    const parts: string[] = []
    for (const section of hwpDoc.sections) {
      const paragraphs = section.content || []
      for (const paragraph of paragraphs) {
        // 1) 일반 텍스트 추출
        const content = paragraph.content || []
        const text = extractTextFromContent(content).trim()
        if (text) parts.push(text)

        // 2) controls 내 테이블 추출 (hwp.js는 표를 controls에 넣음)
        const controls = paragraph.controls || []
        for (const ctrl of controls) {
          const table = extractTableFromControl(ctrl)
          if (table) parts.push(table)
        }
      }
    }

    if (parts.length === 0) {
      return { success: false, fileType: "hwp", error: "HWP 텍스트 추출 실패 (표 형식 문서일 수 있음)" }
    }

    return { success: true, fileType: "hwp", markdown: parts.join("\n\n") }
  } catch (err) {
    return { success: false, fileType: "hwp", error: err instanceof Error ? err.message : "HWP 파싱 실패" }
  }
}
