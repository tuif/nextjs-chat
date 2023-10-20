import { kv } from '@vercel/kv'
// import { OpenAIStream, StreamingTextResponse } from 'ai'
// import { Configuration, OpenAIApi } from 'openai-edge'
import type { ChatCompletionRequestMessage } from 'openai-edge/types/types/chat'

import { auth } from '@/auth'
import { nanoid } from '@/lib/utils'

// 设定代理无法使用edge
// export const runtime = 'edge'

import GlobalProxy from 'node-global-proxy'
import {setGlobalDispatcher, ProxyAgent} from 'undici';
if (process.env.PROXY != null) {
  // 为使用node:http和node:https的请求设置代理
  GlobalProxy.setConfig({
    http: process.env.PROXY,
    https: process.env.PROXY,
  });
  GlobalProxy.start();
  // 为使用undici设置代理
  setGlobalDispatcher(new ProxyAgent(process.env.PROXY));
  console.log('done', process.env.PROXY);
}

import { ChatOpenAI } from 'langchain/chat_models/openai';
import { PromptTemplate } from 'langchain/prompts';
import { RunnablePassthrough, RunnableSequence } from "langchain/schema/runnable";
import { BytesOutputParser, StringOutputParser } from "langchain/schema/output_parser";
import { Pinecone } from '@pinecone-database/pinecone';
import { PineconeStore } from 'langchain/vectorstores/pinecone';
import { OpenAIEmbeddings } from 'langchain/embeddings/openai';
const model = new ChatOpenAI({
  modelName: 'gpt-4',
  // modelName: 'gpt-3.5-turbo',
  openAIApiKey: process.env.OPENAI_API_KEY,
  temperature: 0,
  verbose: true,
});
// 生成独立问题的提示
const rephraser = RunnableSequence.from([
  { // messages => {chatHistory: string, question: string}
    chatHistory: (messages: Array<ChatCompletionRequestMessage>) => messages.slice(0, -1)
        .map(message => `${message.role}: ${message.content}`).join('\n'),
    question: (messages: Array<ChatCompletionRequestMessage>) => messages[messages.length - 1].content,
  },
  // 查询模板
  PromptTemplate.fromTemplate<{
    chatHistory: string,
    question: string,
  }>(
`Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question. The standalone question must be in the same language with the follow-up question
----------------
CHAT HISTORY:
{chatHistory}
----------------
FOLLOWUP QUESTION: {question}
----------------
Standalone question:`
  ), model, new StringOutputParser()]);
const qa = RunnableSequence.from([
  {
    question: new RunnablePassthrough(),
    context: async (question: string) => {
      const store = await PineconeStore.fromExistingIndex(
        new OpenAIEmbeddings({openAIApiKey: process.env.OPENAI_API_KEY}),
        {pineconeIndex: pinecone.Index(process.env.PINECONE_INDEX_NAME!)},
      );
      const docs = await store.asRetriever()
        .getRelevantDocuments(question);
      const context = docs.map((doc) => doc.pageContent).join("\n\n");
      // console.log('context', context);
      return context;
    },
  },
  // 查询模板
  PromptTemplate.fromTemplate<{
    chatHistory: string,
    question: string,
  }>(
`Use the following pieces of context to answer the question at the end. If you don't know the answer, just say that you don't know, don't try to make up an answer. Answer should always be in Chinese.
----------------
CONTEXT:
{context}
----------------
QUESTION: {question}
----------------
Helpful Answer:`
  ), model, new BytesOutputParser()]);
const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
  environment: process.env.PINECONE_ENVIRONMENT!,
});

export async function POST(req: Request) {
  // 读入请求数据
  const {messages, previewToken} = await req.json() as {
    messages: Array<ChatCompletionRequestMessage>,
    previewToken: string,
  }
  // console.log('messages', messages);
  // 不使用preiview-token
  // if (previewToken != null) {
  //   configuration.apiKey = previewToken
  // }
  // 获取user-id
  const userId = (await auth())?.user.id
  if (userId == null) // user-id为空则跳过
    return new Response('Unauthorized', {status: 401})

  // 确定独立问题
  let question: string;
  if (messages.length === 1) {
    question = messages[0].content;
  } else if (messages.length > 1) {
    question = await rephraser.invoke(messages);
  } else throw new Error('invalid');
  console.log('question', question);

  // 独立问题查询
  let stream = await qa.stream(question);
  // stream.on('end', () => {
  //   console.log('The readable stream has ended.');
  // });
  return new Response(stream);
    
  // return new StreamingTextResponse(stream)
  // , {
  //   headers: {
  //     'Content-Type': 'text/plain'
  //   }
  // });
  // return new stream;
  // return new StreamingTextResponse(stream)

  // let streamedResult = "";
  // for await (const chunk of stream) {
  //     streamedResult += chunk;
  //     console.log(streamedResult);
  // }

  // return 
  // 自行生成，实际问题
  // let {content} = messages[messages.length - 1]
  // console.log('messages', messages)
  // const res = await openai.createChatCompletion({
  //   model: 'gpt-3.5-turbo',
  //   messages,
  //   temperature: 0.7,
  //   stream: true
  // })
  // let prompt = `You are a helpful assistant good at answering question\nuser: ${content}\nassistant: `;
  // console.log('prompt', prompt);
  // const res = await openai.createCompletion({
  //   // model: 'gpt-3.5-turbo',
  //   model: 'text-davinci-003',
  //   prompt,
  //   temperature: 0.7,
  //   stream: true
  // })
  // console.log(await res.text())

  // const stream = OpenAIStream(res, {
  //   async onCompletion(completion) {
  //     console.log('complete', completion);
  //     const title = json.messages[0].content.substring(0, 100)
  //     const id = json.id ?? nanoid()
  //     const createdAt = Date.now()
  //     const path = `/chat/${id}`
  //     const payload = {
  //       id,
  //       title,
  //       userId,
  //       createdAt,
  //       path,
  //       messages: [
  //         ...messages,
  //         {
  //           content: completion,
  //           role: 'assistant'
  //         }
  //       ]
  //     }
  //     await kv.hmset(`chat:${id}`, payload)
  //     await kv.zadd(`user:chat:${userId}`, {
  //       score: createdAt,
  //       member: `chat:${id}`
  //     })
  //   }
  // })

  // return new StreamingTextResponse(stream)
}
