// Terminal error handler
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
