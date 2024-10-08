import { ContactResponse } from "./ContactResponse";
import { ConversationFeedbackResponse } from "./ConversationFeedbackResponse";
import { ConversationChannelType, ConversationStatusType } from "./Database";
import { MessageResponse } from "./MessageResponse";

export interface ConversationResponse {
  id: string; // conv_xxx
  organisation_id: string; // org_xxx
  contact: ContactResponse;
  created_at: number;
  last_message_at: number;
  messages: MessageResponse[];
  status: ConversationStatusType;
  summary: string;
  sentiment: number;
  channel: ConversationChannelType;
  feedback: ConversationFeedbackResponse;
  resolution_estimation: number | undefined;
  last_summarisation_at: number | undefined;
}
