/**
 * Terminal error handler.
 *
 * A client-caused failure — an oversized body, malformed JSON — is logged as one
 * line, because a stack trace describes the framework rather than the fault and
 * a caller who can trigger one at will can otherwise fill the log with them. A
 * 5xx keeps the full stack: that one is ours.
 *
 * The response shape is unchanged in both cases.
 */
export const errorHandler = (err, req, res, next) => {
  const status = err.status || err.statusCode || 500

  if (status >= 500) {
    console.error(err)
  } else {
    console.warn(
      `[HTTP ${status}] ${req.method} ${req.originalUrl}: ${err.code ?? err.name}: ${err.message}`
    )
  }

  res.status(status).json({
    error: {
      message: err.message || 'Internal Server Error'
    }
  })
}
