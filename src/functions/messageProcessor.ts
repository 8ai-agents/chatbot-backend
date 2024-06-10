import { app, EventGridEvent, InvocationContext } from "@azure/functions";
import { MessageResponse } from "../models/MessageResponse";
import { handleSingleMessageForOpenAI } from "../OpenAIHandler";
import { db, saveMessageResponsesToDatabase } from "../DatabaseController";
import {
  ConversationChannelType,
  ConversationStatusType,
  MessageCreatorType,
  NewContact,
  NewConversation,
  NewMessage,
} from "../models/Database";
import { createID } from "../Utils";
import { UsersInfoResponse } from "@slack/web-api";

export type SlackSlashMessageEvent = {
  organisation_id: string;
  message: string;
  response_url: string;
  user_id: string;
  user_name: string;
};

export type SlackBotMessageEvent = {
  organisation_id: string;
  message: string;
  user_id: string;
  channel_id: string;
  thread_ts: string;
};

export async function messageProcessor(
  event: EventGridEvent,
  context: InvocationContext
): Promise<void> {
  if (event.eventType === "Message.Slack") {
    // This is for a slash command
    context.log("Incoming Slack Slash Command Message: ", event);
    await processSlackSlashMessage(event, context);
  } else if (event.eventType === "Message.SlackBot") {
    // This is for a bot message
    context.log("Incoming SlackBot Message: ", event);
    await processSlackBotMessage(event, context);
  } else {
    context.log("Don't know how to process this event: ", event);
  }
}

const processSlackBotMessage = async (
  event: EventGridEvent,
  context: InvocationContext
) => {
  /// Process
  try {
    const data = event.data as SlackBotMessageEvent;

    const { assistant_id } = await db
      .selectFrom("organisations")
      .select(["assistant_id"])
      .where("id", "=", data.organisation_id)
      .executeTakeFirst();

    // Get user name from Slack API
    const slackUser = await getUserFromSlack(data.user_id, context);
    const contact_id = await checkGetContactID(
      slackUser.id,
      slackUser.real_name,
      slackUser.profile?.email,
      slackUser.profile?.phone,
      data.organisation_id
    );
    const conversation_id = await checkGetConversation(
      data.thread_ts,
      data.organisation_id,
      slackUser.is_admin,
      contact_id
    );

    let messageResponse: MessageResponse[] | undefined = undefined;

    if (!slackUser.is_admin) {
      // We only answer the message if the message sender is not an admin
      messageResponse = await handleSingleMessageForOpenAI(
        assistant_id,
        data.message.toString(),
        context
      );

      let response = messageResponse.map((r) => r.message).join("\n");
      const citationsWithURLs: string[] = messageResponse
        .flatMap((m) => m.citations && m.citations.map((c) => c.url))
        .filter((c) => c !== undefined && c !== "");
      if (citationsWithURLs.length > 0) {
        // Process citations with URLs
        response += `\n\nThese links might help you:\n${citationsWithURLs.join(
          "\n"
        )}`;
      }
      response +=
        "\nIf this solved your question give the message a :white_check_mark:";

      await postBotResponseToSlack(
        {
          channel: data.channel_id,
          text: response,
          thread_ts: data.thread_ts,
        },
        context
      );
    }

    if (conversation_id) {
      // We only save the inbound message if the conversation exists
      const inboundMessage: NewMessage = {
        id: createID("msg"),
        conversation_id,
        message: data.message,
        creator: slackUser.is_admin
          ? MessageCreatorType.USER
          : MessageCreatorType.CONTACT,
        version: 1,
        created_at: Date.now(),
      };

      await db.insertInto("messages").values(inboundMessage).execute();
      if (messageResponse) {
        for (const [index, mr] of messageResponse.entries()) {
          mr.conversation_id = conversation_id;
          mr.created_at = inboundMessage.created_at + index + 1;
        }
        await saveMessageResponsesToDatabase(messageResponse, false);
      }
    }
  } catch (error) {
    context.error("Error processing Slack message: ", error);
    await postBotResponseToSlack(
      {
        channel: event.data.channel_id.toString(),
        text: "An error occured wth this message, please contact your adminstrator.",
        thread_ts: event.data.thread_ts.toString(),
      },
      context
    );
  }
};

const processSlackSlashMessage = async (
  event: EventGridEvent,
  context: InvocationContext
) => {
  /// Process
  try {
    const data = event.data as SlackSlashMessageEvent;

    const { assistant_id } = await db
      .selectFrom("organisations")
      .select(["assistant_id"])
      .where("id", "=", data.organisation_id)
      .executeTakeFirst();

    const messageResponse: MessageResponse[] =
      await handleSingleMessageForOpenAI(
        assistant_id,
        data.message.toString(),
        context
      );

    let response = messageResponse.map((r) => r.message).join("\n");
    const citationsWithURLs: string[] = messageResponse
      .flatMap((m) => m.citations && m.citations.map((c) => c.url))
      .filter((c) => c !== undefined && c !== "");
    if (citationsWithURLs.length > 0) {
      // Process citations with URLs
      response += `\n\nThese links might help you:\n${citationsWithURLs.join(
        "\n"
      )}`;
    }
    response +=
      "\nIf this solved your question give the message a :white_check_mark:";

    await postSlashResponseToSlack(data.response_url, response, context);

    const contact_id = await checkGetContactID(
      data.user_id,
      data.user_name,
      "",
      "",
      data.organisation_id
    );
    const conversation_id = await checkGetConversation(
      data.response_url,
      data.organisation_id,
      false,
      contact_id
    );

    const inboundMessage: NewMessage = {
      id: createID("msg"),
      conversation_id,
      message: data.message,
      creator: MessageCreatorType.CONTACT,
      version: 1,
      created_at: Date.now(),
    };

    for (const [index, mr] of messageResponse.entries()) {
      mr.conversation_id = conversation_id;
      mr.created_at = inboundMessage.created_at + index + 1;
    }

    await db.insertInto("messages").values(inboundMessage).execute();
    await saveMessageResponsesToDatabase(messageResponse, false);
  } catch (error) {
    context.error("Error processing Slack message: ", error);
    await postSlashResponseToSlack(
      event.data.response_url.toString(),
      "An error occured wth this message, please contact your adminstrator.",
      context
    );
  }
};

const postBotResponseToSlack = async (
  data: {
    channel: string;
    text: string;
    thread_ts: string;
  },
  context: InvocationContext
) => {
  return await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    body: JSON.stringify(data),
    headers: {
      "Content-type": "application/json",
      Authorization: "Bearer " + process.env.SLACK_BOT_TOKEN,
    },
  })
    .then(() => context.log("Processed Slack Message"))
    .catch((error) => {
      context.log(error);
      throw error;
    });
};

const postSlashResponseToSlack = async (
  response_url: string,
  text: string,
  context: InvocationContext
) => {
  return await fetch(response_url, {
    method: "POST",
    body: JSON.stringify({
      response_type: "in_channel",
      replace_original: true,
      text,
    }),
    headers: {
      "Content-type": "application/json; charset=UTF-8",
    },
  })
    .then(() => context.log("Processed Slack Message"))
    .catch((error) => {
      context.log(error);
      throw error;
    });
};

const getUserFromSlack = async (
  user_id: string,
  context: InvocationContext
) => {
  return await fetch("https://slack.com/api/users.info", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `user=${user_id}`,
  })
    .then(async (response) => await response.json())
    .then(async (response: UsersInfoResponse) =>
      response.ok && response.user
        ? response.user
        : Promise.reject(response.error)
    )
    .catch((error) => {
      context.log(error);
      throw error;
    });
};

const checkGetContactID = async (
  slack_id: string,
  slack_name: string,
  slack_email: string,
  slack_phone: string,
  organisation_id: string
) => {
  // First check if there is an existing contact and conversation
  let contact_id: string = createID("cont");
  const contact = await db
    .selectFrom("contacts")
    .select(["id"])
    .where("slack_id", "=", slack_id)
    .executeTakeFirst();

  if (contact && contact.id) {
    contact_id = contact.id;
  } else {
    // we need to create a new contact
    const newContact: NewContact = {
      id: contact_id,
      organisation_id,
      name: slack_name,
      email: slack_email,
      phone: slack_phone,
      slack_id: slack_id,
    };
    await db.insertInto("contacts").values(newContact).execute();
  }
  return contact_id;
};

const checkGetConversation = async (
  thread_ts: string,
  organisation_id: string,
  messageIsFromAdmin: boolean,
  contact_id: string
): Promise<string | undefined> => {
  let conversation_id: string = createID("conv");
  const conversation = await db
    .selectFrom("conversations")
    .selectAll()
    .where("channel_id", "=", thread_ts)
    .executeTakeFirst();

  if (conversation && conversation.id) {
    conversation_id = conversation.id;
    if (messageIsFromAdmin) {
      // Set the interrupted flag to true
      await db
        .updateTable("conversations")
        .set({ interrupted: true })
        .where("id", "=", conversation_id)
        .executeTakeFirst();
    }
  } else if (!messageIsFromAdmin) {
    // we need to create a new conversation
    const newConversation: NewConversation = {
      id: conversation_id,
      organisation_id,
      contact_id,
      created_at: Date.now(),
      last_message_at: Date.now(),
      interrupted: false,
      status: ConversationStatusType.OPEN,
      sentiment: 0,
      channel: ConversationChannelType.SLACK,
      channel_id: thread_ts,
    };
    await db.insertInto("conversations").values(newConversation).execute();
  } else {
    // We nullify the id if the message is from an admin
    conversation_id = undefined;
  }
  return conversation_id;
};

app.eventGrid("messageProcessor", {
  handler: messageProcessor,
});
