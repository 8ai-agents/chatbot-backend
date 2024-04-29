import { ContactResponse } from "./ContactResponse";
import { ConversationStatusType } from "./Database";
import { MessageResponse } from "./MessageResponse";

export interface ConversationResponse {
  id: string; // conv_xxx
  contact: ContactResponse;
  created_at: number;
  last_message_at: number;
  messages: MessageResponse[];
  status: ConversationStatusType;
  summary: string;
  sentiment: number;
}
