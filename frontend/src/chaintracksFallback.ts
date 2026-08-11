const isChaintracksNotFound = (error: unknown): boolean => {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''

  try {
    const response = JSON.parse(message) as { status?: string; code?: string }
    return response.status === 'error' && response.code === 'ERR_NOT_FOUND'
  } catch {
    return false
  }
}

export const fallBackOnChaintracksNotFound = <T>(
  findHeaderForBlockHash: (hash: string) => Promise<T | undefined>,
): ((hash: string) => Promise<T | undefined>) => async (hash) => {
  try {
    return await findHeaderForBlockHash(hash)
  } catch (error) {
    // wallet-toolbox-client 1.x throws for Chaintracks ERR_NOT_FOUND responses.
    // Returning undefined lets Services.hashToHeader continue to WhatsOnChain.
    if (isChaintracksNotFound(error)) return undefined
    throw error
  }
}
