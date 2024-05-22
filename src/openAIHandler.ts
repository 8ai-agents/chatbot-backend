import OpenAI, { toFile } from "openai";
import { MessageRequest } from "./models/MessageRequest";
import { MessageResponse } from "./models/MessageResponse";
import { InvocationContext } from "@azure/functions";
import { MessageCreatorType, NewOrganisationFile } from "./models/Database";
import { db } from "./DatabaseController";
import { Message } from "openai/resources/beta/threads/messages";
import { AssistantTool } from "openai/resources/beta/assistants";

export const handleMessageForOpenAI = async (
  messageRequest: MessageRequest,
  assistant_id: string,
  contact_id: string,
  context: InvocationContext
) => {
  const openai = new OpenAI({
    apiKey: process.env.OPEN_API_KEY,
  });
  const thread_id = messageRequest.conversation_id.replace("conv_", "thread_");
  await openai.beta.threads.messages.create(thread_id, {
    role: "user",
    content: messageRequest.message,
  });

  let run = await openai.beta.threads.runs.createAndPoll(
    thread_id,
    {
      assistant_id,
      instructions: "",
    },
    { pollIntervalMs: 1000 }
  );

  const messageResponse: MessageResponse[] = [];

  if (run.status === "requires_action") {
    context.log(
      `function call detected: ${JSON.stringify(
        run.required_action.submit_tool_outputs
      )}`
    );

    const tool_outputs = run.required_action.submit_tool_outputs.tool_calls.map(
      async (tc) => {
        let output = `{ "success": "true" }`;
        if (tc.function.name === "save_contact_details") {
          output = await saveContactDetails(contact_id, tc.function.arguments);
          context.log(`Save Contact Details: ${output}`);
        }
        return {
          tool_call_id: tc.id,
          output,
        };
      }
    );

    run = await openai.beta.threads.runs.submitToolOutputsAndPoll(
      thread_id,
      run.id,
      {
        tool_outputs: await Promise.all(tool_outputs),
      },
      { pollIntervalMs: 1000 }
    );
  }

  if (run.status === "completed") {
    const messages = await openai.beta.threads.messages.list(run.thread_id, {
      limit: 5,
    });
    for (const message of messages.data.slice(
      0,
      messages.data.findIndex((m) => m.role === "user")
    )) {
      // Gets all messages from the assistant since last user message
      if (message.content[0].type === "text") {
        messageResponse.push(
          await processOpenAIMessage(
            message,
            messageRequest.conversation_id,
            context
          )
        );
      }
    }
  } else {
    context.error(run.status);
    throw new Error("OpenAI request failed");
  }

  return messageResponse;
};

export const processOpenAIMessage = async (
  message: Message,
  conversation_id: string,
  context: InvocationContext
): Promise<MessageResponse> => {
  if (message.content[0].type === "text") {
    let messageTextContent = message.content[0].text.value;
    if (message.content[0].text.annotations?.length > 0) {
      // there are annotations that we should process
      for (const annotation of message.content[0].text.annotations) {
        if (annotation.type === "file_citation" && annotation.file_citation) {
          context.log(
            `File citation found "${annotation.file_citation.quote}", starting at ${annotation.start_index} and ending at ${annotation.end_index}`
          );
        }
        messageTextContent = messageTextContent.replace(annotation.text, "");
      }
    }
    return new MessageResponse(
      conversation_id,
      messageTextContent,
      MessageCreatorType.AGENT,
      message.created_at * 1000
    );
  }
};

export const createAssistant = async (
  organisation_id: string,
  organisation_name: string,
  filename: string,
  filedata: string
) => {
  const openai = new OpenAI({
    apiKey: process.env.OPEN_API_KEY,
  });

  try {
    const myAssistant = await openai.beta.assistants.create({
      name: `8ai-${organisation_name
        .trim()
        .split(" ")
        .join("-")
        .toLowerCase()}`,
      instructions: `You are a customer support agent for ${organisation_name}. Please answer concisely and nicely to potential customers, if you don't know the answer or the question is sensitive, please ask them to provide a phone number for a call back by an expert within 2 business days.`,
      model: "gpt-4o",
      tools: getToolModel(false),
    });

    if (filedata) {
      await updateAssistantFile(
        organisation_id,
        myAssistant.id,
        filename,
        filedata
      );
    }
    return myAssistant.id;
  } catch (e) {
    console.error(`Failed to create assistant in OpenAI: ${e.message}`);
    throw "Failed to create AI assistant";
  }
};

export const updateAssistantFile = async (
  organisation_id: string,
  assistant_id: string,
  filename: string,
  filedata: string
) => {
  const openai = new OpenAI({
    apiKey: process.env.OPEN_API_KEY,
  });
  let jsonData = {};
  try {
    jsonData = JSON.parse(filedata);
  } catch {
    throw "File is not a valid JSON";
  }

  try {
    const assistant = await openai.beta.assistants.retrieve(assistant_id);
    if (assistant.tools?.some((t) => t.type === "file_search")) {
      // Delete existing files attached to this vector store
      for (const vector_store_id of assistant.tool_resources.file_search
        .vector_store_ids) {
        const files = await openai.beta.vectorStores.files.list(
          vector_store_id,
          {
            limit: 100,
          }
        );
        for (const file of files.data) {
          await openai.files.del(file.id);
        }
        await openai.beta.vectorStores.del(vector_store_id);
      }
    }
    await db
      .deleteFrom("organisation_files")
      .where("organisation_id", "=", organisation_id)
      .execute();

    // add new files

    let newOrganisationFiles: NewOrganisationFile[] = [];

    let i = 0;
    for (const key in jsonData) {
      try {
        const content: { text: string } = { text: jsonData[key] };
        const newFile = await openai.files.create({
          file: await toFile(
            Buffer.from(JSON.stringify(content)),
            `${assistant_id}-${i}.jsonl`
          ),
          purpose: "assistants",
        });

        newOrganisationFiles.push({
          id: newFile.id,
          organisation_id,
          url: key,
          content: jsonData[key],
        });
        i++;
      } catch {
        // carry on with others
      }
    }

    // create a new vector store
    const newVectorStore = await openai.beta.vectorStores.create({
      name: `vs_for_${assistant_id}`,
      file_ids: newOrganisationFiles.map((f) => f.id),
    });
    await openai.beta.assistants.update(assistant_id, {
      tools: getToolModel(true),
      tool_resources: {
        file_search: {
          vector_store_ids: [newVectorStore.id],
        },
      },
    });
    await db
      .insertInto("organisation_files")
      .values(newOrganisationFiles)
      .execute();
  } catch (e) {
    throw "Failed to update AI assistant";
  }
};

type SaveContactDetailsPayload = {
  name?: string;
  email?: string;
  phone?: string;
};

const saveContactDetails = async (
  contact_id: string,
  data: string
): Promise<string> => {
  try {
    const details = JSON.parse(data) as SaveContactDetailsPayload;
    await db
      .updateTable("contacts")
      .set({
        name: details.name,
        email: details.email,
        phone: details.phone,
      })
      .where("id", "=", contact_id)
      .execute();
    return JSON.stringify(details);
  } catch (error) {
    return "Can't parse details";
  }
};

const getToolModel = (hasFile: boolean): AssistantTool[] => {
  return hasFile
    ? [
        {
          type: "file_search",
        },
        {
          type: "function",
          function: {
            name: "save_contact_details",
            description: "Save contact details of user to database",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The user's name",
                },
                email: {
                  type: "string",
                  description: "The user's email",
                },
                phone: {
                  type: "string",
                  description: "The user's phone number",
                },
              },
              required: [],
            },
          },
        },
      ]
    : [
        {
          type: "function",
          function: {
            name: "save_contact_details",
            description: "Save contact details of user to database",
            parameters: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "The user's name",
                },
                email: {
                  type: "string",
                  description: "The user's email",
                },
                phone: {
                  type: "string",
                  description: "The user's phone number",
                },
              },
              required: [],
            },
          },
        },
      ];
};
