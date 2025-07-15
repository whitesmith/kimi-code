// Adapted from https://github.com/maxnowack/anthropic-proxy/blob/main/index.js

const Fastify = require('fastify')
const { TextDecoder } = require('util')

let config = {}
let fastify = null

function debug(...args) {
  if (!config.debug) return
  console.log(...args)
}

// Helper function to send SSE events and flush immediately.
const sendSSE = (reply, event, data) => {
  // Check if connection is still open and headers haven't been sent yet or we're in streaming mode
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return false
  }
  
  try {
    const sseMessage = `event: ${event}\n` +
                       `data: ${JSON.stringify(data)}\n\n`
    reply.raw.write(sseMessage)
    // Flush if the flush method is available.
    if (typeof reply.raw.flush === 'function') {
      reply.raw.flush()
    }
    return true
  } catch (error) {
    console.error('Error sending SSE:', error.message)
    return false
  }
}

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use'
    case 'stop': return 'end_turn'
    case 'length': return 'max_tokens'
    default: return 'end_turn'
  }
}

const start = async (port = 3000, options = {}) => {
  // Initialize config with passed options
  config = {
    baseUrl: options.baseUrl || 'https://api.groq.com/openai',
    key: options.key,
    models: {
      reasoning: options.reasoningModel || 'moonshotai/kimi-k2-instruct',
      completion: options.completionModel || 'moonshotai/kimi-k2-instruct',
    },
    maxTokens: options.maxTokens || 16384,
    debug: options.debug || false
  }

  // Initialize fastify with debug logging if enabled
  fastify = Fastify({
    logger: config.debug
  })

  // Register the route
  fastify.post('/v1/messages', async (request, reply) => {
    let hasStartedStreaming = false
    let connectionClosed = false
    
    // Handle connection close
    reply.raw.on('close', () => {
      connectionClosed = true
    })
    
    reply.raw.on('error', () => {
      connectionClosed = true
    })
    
    try {
      const payload = request.body

      // Helper to normalize a message's content.
      // If content is a string, return it directly.
      // If it's an array (of objects with text property), join them.
      const normalizeContent = (content) => {
        if (typeof content === 'string') return content
        if (Array.isArray(content)) {
          return content.map(item => item.text).join(' ')
        }
        return null
      }

      // Build messages array for the OpenAI payload.
      // Start with system messages if provided.
      const messages = []
      if (payload.system && Array.isArray(payload.system)) {
        payload.system.forEach(sysMsg => {
          const normalized = normalizeContent(sysMsg.text || sysMsg.content)
          if (normalized) {
            messages.push({
              role: 'system',
              content: normalized
            })
          }
        })
      }
      // Then add user (or other) messages.
      if (payload.messages && Array.isArray(payload.messages)) {
        payload.messages.forEach(msg => {
          const toolCalls = (Array.isArray(msg.content) ? msg.content : []).filter(item => item.type === 'tool_use').map(toolCall => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input),
            }
          }))
          const newMsg = { role: msg.role }
          const normalized = normalizeContent(msg.content)
          if (normalized) newMsg.content = normalized
          if (toolCalls.length > 0) newMsg.tool_calls = toolCalls
          if (newMsg.content || newMsg.tool_calls) messages.push(newMsg)

          if (Array.isArray(msg.content)) {
            const toolResults = msg.content.filter(item => item.type === 'tool_result')
            toolResults.forEach(toolResult => {
              messages.push({
                role: 'tool',
                content: toolResult.text || toolResult.content,
                tool_call_id: toolResult.tool_use_id,
              })
            })
          }
        })
      }

      // Prepare the OpenAI payload.
      // Helper function to recursively traverse JSON schema and remove format: 'uri'
      const removeUriFormat = (schema) => {
        if (!schema || typeof schema !== 'object') return schema;

        // If this is a string type with uri format, remove the format
        if (schema.type === 'string' && schema.format === 'uri') {
          const { format, ...rest } = schema;
          return rest;
        }

        // Handle array of schemas (like in anyOf, allOf, oneOf)
        if (Array.isArray(schema)) {
          return schema.map(item => removeUriFormat(item));
        }

        // Recursively process all properties
        const result = {};
        for (const key in schema) {
        if (key === 'properties' && typeof schema[key] === 'object') {
          result[key] = {};
          for (const propKey in schema[key]) {
            result[key][propKey] = removeUriFormat(schema[key][propKey]);
          }
        } else if (key === 'items' && typeof schema[key] === 'object') {
          result[key] = removeUriFormat(schema[key]);
        } else if (key === 'additionalProperties' && typeof schema[key] === 'object') {
          result[key] = removeUriFormat(schema[key]);
        } else if (['anyOf', 'allOf', 'oneOf'].includes(key) && Array.isArray(schema[key])) {
          result[key] = schema[key].map(item => removeUriFormat(item));
        } else {
          result[key] = removeUriFormat(schema[key]);
        }
        }
        return result;
      };

      const tools = (payload.tools || []).filter(tool => !['BatchTool'].includes(tool.name)).map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: removeUriFormat(tool.input_schema),
        },
      }))
      const openaiPayload = {
        model: payload.thinking ? config.models.reasoning : config.models.completion,
        messages,
        max_tokens: config.maxTokens,
        temperature: payload.temperature !== undefined ? payload.temperature : 1,
        stream: payload.stream === true,
      }
      if (tools.length > 0) openaiPayload.tools = tools
      debug('OpenAI payload:', openaiPayload)

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.key}`,
      }
      
      const openaiResponse = await fetch(`${config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiPayload)
      });

      if (!openaiResponse.ok) {
        const errorDetails = await openaiResponse.text()
        if (!reply.sent && !hasStartedStreaming && !connectionClosed) {
          reply.code(openaiResponse.status)
          return { error: errorDetails }
        }
        return
      }

      // If stream is not enabled, process the complete response.
      if (!openaiPayload.stream) {
        const data = await openaiResponse.json()
        debug('OpenAI response:', data)
        if (data.error) {
          throw new Error(data.error.message)
        }


        const choice = data.choices[0]
        const openaiMessage = choice.message

        // Map finish_reason to anthropic stop_reason.
        const stopReason = mapStopReason(choice.finish_reason)
        const toolCalls = openaiMessage.tool_calls || []

        // Create a message id; if available, replace prefix, otherwise generate one.
        const messageId = data.id
          ? data.id.replace('chatcmpl', 'msg')
          : 'msg_' + Math.random().toString(36).substr(2, 24)

        const anthropicResponse = {
          content: [
            {
              text: openaiMessage.content,
              type: 'text'
            },
            ...toolCalls.map(toolCall => ({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments),
            })),
          ],
          id: messageId,
          model: openaiPayload.model,
          role: openaiMessage.role,
          stop_reason: stopReason,
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: data.usage
              ? data.usage.prompt_tokens
              : messages.reduce((acc, msg) => acc + msg.content.split(' ').length, 0),
            output_tokens: data.usage
              ? data.usage.completion_tokens
              : openaiMessage.content.split(' ').length,
          }
        }

        return anthropicResponse
      }


      let isSucceeded = false
      let isStreamingStarted = false
      
      function sendSuccessMessage() {
        if (isSucceeded || reply.sent || connectionClosed || hasStartedStreaming) return
        isSucceeded = true
        isStreamingStarted = true
        hasStartedStreaming = true

        try {
          // Streaming response using Server-Sent Events.
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })
        } catch (error) {
          console.error('Error writing headers:', error.message)
          connectionClosed = true
          return
        }

        // Create a unique message id.
        const messageId = 'msg_' + Math.random().toString(36).substr(2, 24)

        // Send initial SSE event for message start.
        sendSSE(reply, 'message_start', {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: openaiPayload.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        })

        // Send initial ping.
        sendSSE(reply, 'ping', { type: 'ping' })
      }

      // Prepare for reading streamed data.
      let accumulatedContent = ''
      let accumulatedReasoning = ''
      let usage = null
      let textBlockStarted = false
      let encounteredToolCall = false
      const toolCallAccumulators = {}  // key: tool call index, value: accumulated arguments string
      const decoder = new TextDecoder('utf-8')
      const reader = openaiResponse.body.getReader()
      let done = false
      let buffer = '' // Buffer to accumulate partial chunks
      let incompleteDataLine = '' // Buffer for incomplete data: lines

      while (!done && !connectionClosed) {
        const { value, done: doneReading } = await reader.read()
        done = doneReading
        if (value && !connectionClosed) {
          const chunk = decoder.decode(value, { stream: true })
          debug('OpenAI response chunk:', chunk)
          
          // Add new chunk to buffer
          buffer += chunk
          
          // Split by lines and process complete lines only
          const lines = buffer.split('\n')
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (connectionClosed) break
            const trimmed = line.trim()
            if (trimmed === '' || !trimmed.startsWith('data:')) continue
            
            // Handle incomplete data lines by accumulating them
            let dataStr = trimmed.replace(/^data:\s*/, '')
            if (incompleteDataLine) {
              dataStr = incompleteDataLine + dataStr
              incompleteDataLine = ''
            }
            
            if (dataStr === '[DONE]') {
              // Finalize the stream with stop events.
              if (encounteredToolCall) {
                for (const idx in toolCallAccumulators) {
                  if (connectionClosed) break
                  sendSSE(reply, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: parseInt(idx, 10)
                  })
                }
              } else if (textBlockStarted && !connectionClosed) {
                sendSSE(reply, 'content_block_stop', {
                  type: 'content_block_stop',
                  index: 0
                })
              }
              if (!connectionClosed) {
                sendSSE(reply, 'message_delta', {
                  type: 'message_delta',
                  delta: {
                    stop_reason: encounteredToolCall ? 'tool_use' : 'end_turn',
                    stop_sequence: null
                  },
                  usage: usage
                    ? { output_tokens: usage.completion_tokens }
                    : { output_tokens: accumulatedContent.split(' ').length + accumulatedReasoning.split(' ').length }
                })
                sendSSE(reply, 'message_stop', {
                  type: 'message_stop'
                })
                try {
                  reply.raw.end()
                } catch (error) {
                  // Ignore error if already closed
                }
              }
              return
            }

            if (connectionClosed) break
            
            try {
              const parsed = JSON.parse(dataStr)
              if (parsed.error) {
                throw new Error(parsed.error.message)
              }
              if (!isStreamingStarted && !connectionClosed) {
                sendSuccessMessage()
              }
              // Capture usage if available.
              if (parsed.usage) {
                usage = parsed.usage
              }
              const delta = parsed.choices?.[0]?.delta
              if (delta && delta.tool_calls && !connectionClosed) {
                for (const toolCall of delta.tool_calls) {
                  if (connectionClosed) break
                  encounteredToolCall = true
                  const idx = toolCall.index
                  if (toolCallAccumulators[idx] === undefined) {
                    toolCallAccumulators[idx] = ""
                    sendSSE(reply, 'content_block_start', {
                      type: 'content_block_start',
                      index: idx,
                      content_block: {
                        type: 'tool_use',
                        id: toolCall.id,
                        name: toolCall.function.name,
                        input: {}
                      }
                    })
                  }
                  const newArgs = toolCall.function.arguments || ""
                  const oldArgs = toolCallAccumulators[idx]
                  if (newArgs.length > oldArgs.length) {
                    const deltaText = newArgs.substring(oldArgs.length)
                    sendSSE(reply, 'content_block_delta', {
                      type: 'content_block_delta',
                      index: idx,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: deltaText
                      }
                    })
                    toolCallAccumulators[idx] = newArgs
                  }
                }
              } else if (delta && delta.content && !connectionClosed) {
                if (!textBlockStarted) {
                  textBlockStarted = true
                  sendSSE(reply, 'content_block_start', {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                      type: 'text',
                      text: ''
                    }
                  })
                }
                accumulatedContent += delta.content
                sendSSE(reply, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'text_delta',
                    text: delta.content
                  }
                })
              } else if (delta && delta.reasoning && !connectionClosed) {
                if (!textBlockStarted) {
                  textBlockStarted = true
                  sendSSE(reply, 'content_block_start', {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                      type: 'text',
                      text: ''
                    }
                  })
                }
                accumulatedReasoning += delta.reasoning
                sendSSE(reply, 'content_block_delta', {
                  type: 'content_block_delta',
                  index: 0,
                  delta: {
                    type: 'thinking_delta',
                    thinking: delta.reasoning
                  }
                })
              }
            } catch (parseError) {
              // Check if this is an incomplete JSON object that we should buffer
              if (parseError.message.includes('Unterminated') || 
                  parseError.message.includes('Unexpected end') || 
                  parseError.message.includes('Unexpected token')) {
                debug('Buffering incomplete JSON:', dataStr)
                incompleteDataLine = dataStr
                continue
              }
              // Skip other malformed JSON chunks
              debug('Skipping malformed JSON chunk:', dataStr, parseError.message)
              continue
            }
          }
        }
      }

      if (!connectionClosed) {
        try {
          reply.raw.end()
        } catch (error) {
          // Ignore error if already closed
        }
      }
    } catch (err) {
      console.error(err)
      if (!reply.sent && !hasStartedStreaming && !connectionClosed) {
        reply.code(500)
        return { error: err.message }
      }
    }
  })

  try {
    await fastify.listen({ port })
    return fastify
  } catch (err) {
    throw err
  }
}

// Export the start function for use as a module
module.exports = { start }

// If this file is run directly, start the server
if (require.main === module) {
  start().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
