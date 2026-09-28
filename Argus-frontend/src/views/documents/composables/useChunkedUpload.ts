// src/composables/useChunkedUpload.ts
import { ref, type Ref } from 'vue'
import {
  initDocumentUpload,
  uploadDocumentChunk,
  fetchUploadStatus,
  completeDocumentUpload,
  type UploadStatusResult,
} from '@/api/document'

// ============ 类型导出 ============
export type ChunkedStage = 'hashing' | 'init' | 'uploading' | 'completing' | null

export interface ChunkProgress {
  uploaded: number
  total: number
}

export interface ChunkedUploadState {
  isUploading: Ref<boolean>
  progress: Ref<number>
  error: Ref<string | null>
  stage: Ref<ChunkedStage>
  hashingProgress: Ref<string | null>
  chunkProgress: Ref<ChunkProgress>
  reset: () => void
  uploadFile: (file: File, groupId: number) => Promise<void>
  cancel: () => void
}

// ============ 可配置常量 ============
const CHUNK_SIZE = 4 * 1024 * 1024 // 4MB
const CONCURRENCY = 3              // 并发上传数

// ============ 工具函数 ============

/** 计算文件整体的 SHA-256 哈希（用于秒传） */
async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 计算单个分片的 SHA-256 哈希 */
async function computeChunkHash(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

/** 提取已上传分片列表（兼容后端返回格式） */
function extractUploadedChunks(status: UploadStatusResult): number[] {
  return status.uploadedChunks ?? []
}

// ============ 核心组合式函数 ============
export function useChunkedUpload(): ChunkedUploadState {
  // ---------- 响应式状态 ----------
  const isUploading = ref(false)
  const progress = ref(0)
  const error = ref<string | null>(null)
  const stage = ref<ChunkedStage>(null)
  const hashingProgress = ref<string | null>(null)
  const chunkProgress = ref<ChunkProgress>({ uploaded: 0, total: 0 })

  // ---------- 内部控制 ----------
  let abortController: AbortController | null = null
  let uploadId: string | null = null
  let isCancelled = false

  // ---------- 重置 ----------
  function reset() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    isUploading.value = false
    progress.value = 0
    error.value = null
    stage.value = null
    hashingProgress.value = null
    chunkProgress.value = { uploaded: 0, total: 0 }
    uploadId = null
    isCancelled = false
  }

  // ---------- 取消 ----------
  function cancel() {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    isCancelled = true
    isUploading.value = false
    stage.value = null
    progress.value = 0
    chunkProgress.value = { uploaded: 0, total: 0 }
    // 注意：后端没有提供显式的 abort 接口，但我们会丢弃这个 uploadId
    uploadId = null
  }

  // ---------- 核心上传逻辑 ----------
  async function uploadFile(file: File, groupId: number) {
    // 如果已有上传在进行，先取消
    if (isUploading.value) cancel()
    reset()
    isCancelled = false

    if (!file || !groupId) {
      error.value = '文件或群组信息缺失'
      return
    }

    const totalBytes = file.size
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE)

    try {
      // ---- 1. 计算文件哈希 ----
      stage.value = 'hashing'
      hashingProgress.value = '正在计算文件指纹...'
      const fileHash = await computeFileHash(file)
      hashingProgress.value = null

      // ---- 2. 初始化上传会话 ----
      stage.value = 'init'
      const initResult = await initDocumentUpload({
        groupId,
        fileName: file.name,
        fileSize: totalBytes,
        contentType: file.type || 'application/octet-stream',
        fileHash,
        chunkSize: CHUNK_SIZE,
        chunkCount: totalChunks,
      })

      // 秒传成功
      if (initResult.instantUpload) {
        stage.value = null
        progress.value = 100
        isUploading.value = false
        // 如果后端返回了 documentId，可以保留，但此处不处理
        return
      }

      // 获取 uploadId 和已上传分片
      if (!initResult.uploadId) {
        throw new Error('服务器未返回上传会话 ID')
      }
      uploadId = initResult.uploadId
      const uploadedChunks = initResult.uploadedChunks ?? []

      // 如果后端提供了已上传分片，则使用；否则可以通过 fetchUploadStatus 查询（但初始化已返回）
      // 我们直接使用 initResult 中的信息

      // ---- 3. 分片上传 ----
      stage.value = 'uploading'
      chunkProgress.value = {
        uploaded: uploadedChunks.length,
        total: totalChunks,
      }
      // 计算整体进度（已上传分片数 / 总分片数）
      progress.value = Math.round((uploadedChunks.length / totalChunks) * 100)

      // 创建 AbortController 用于取消
      abortController = new AbortController()
      const { signal } = abortController

      // 需要上传的分片索引列表（排除已上传的）
      const pendingChunks: number[] = []
      const uploadedSet = new Set(uploadedChunks)
      for (let i = 0; i < totalChunks; i++) {
        if (!uploadedSet.has(i)) {
          pendingChunks.push(i)
        }
      }

      // 并发上传控制
      let uploadedCount = uploadedChunks.length

      // 辅助：上传单个分片
      async function uploadOneChunk(index: number) {
        const start = index * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, totalBytes)
        const chunkBlob = file.slice(start, end)

        // 计算分片哈希（用于完整性校验）
        const chunkHash = await computeChunkHash(chunkBlob)

        // 调用上传 API
        await uploadDocumentChunk(
          {
            uploadId: uploadId!,
            chunkIndex: index,
            chunkHash,
            chunk: chunkBlob,
          },
          undefined, // 不单独跟踪字节进度
          signal,
        )

        // 更新进度
        uploadedCount++
        chunkProgress.value.uploaded = uploadedCount
        progress.value = Math.round((uploadedCount / totalChunks) * 100)
      }

      // 启动并发队列
      const tasks: Promise<void>[] = []
      for (const idx of pendingChunks) {
        // 如果已经取消，跳出循环
        if (signal.aborted) break

        tasks.push(uploadOneChunk(idx))

        // 达到并发数时等待一批完成
        if (tasks.length >= CONCURRENCY) {
          await Promise.all(tasks)
          tasks.length = 0
        }
      }
      // 等待剩余任务
      if (tasks.length > 0) {
        await Promise.all(tasks)
      }

      // 检查是否取消
      if (signal.aborted) {
        throw new Error('canceled')
      }

      // 所有分片上传完成，校验进度
      if (uploadedCount !== totalChunks) {
        throw new Error(`分片上传不完整：${uploadedCount}/${totalChunks}`)
      }

      // ---- 4. 完成上传 ----
      stage.value = 'completing'
      await completeDocumentUpload(uploadId, signal)

      // 上传成功
      stage.value = null
      progress.value = 100
      isUploading.value = false
      uploadId = null
    } catch (err: any) {
      // 取消导致的错误，不设置错误信息
      if (isCancelled || err?.message === 'canceled' || err?.name === 'AbortError') {
        return
      }

      // 其他错误
      error.value = err?.message || '分片上传失败'
      // 如果还有 uploadId，可以尝试查询状态，但这里不处理
      isUploading.value = false
      stage.value = null
      progress.value = 0
      chunkProgress.value = { uploaded: 0, total: 0 }
      uploadId = null
    } finally {
      abortController = null
      isUploading.value = false
    }
  }

  // ---------- 返回接口 ----------
  return {
    isUploading,
    progress,
    error,
    stage,
    hashingProgress,
    chunkProgress,
    reset,
    uploadFile,
    cancel,
  }
}
