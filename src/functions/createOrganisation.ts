import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { authenticateRequest } from "../AuthController";
import { NewOrganisation } from "../models/Database";
import { OrganisationRequest } from "../models/OrganisationRequest";
import { db, getOrganisation } from "../DatabaseController";
import { checkUserIsAdmin, createID } from "../Utils";
import { createAssistant } from "../OpenAIHandler";

export async function createOrganisation(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const { email } = await authenticateRequest(request);
    if (!checkUserIsAdmin("", email, true)) return { status: 403 };
  } catch {
    return { status: 401 };
  }

  try {
    const organisationRequest = (await request.json()) as OrganisationRequest;

    context.log(`Creating organisation ${organisationRequest.name}`);
    const organisationToSave: NewOrganisation = {
      id: createID("org"),
      name: organisationRequest.name,
      assistant_id: undefined,
      description: organisationRequest.description,
      website: organisationRequest.website,
      logo_url: organisationRequest.logo_url,
      support_email: organisationRequest.support_email,
      support_phone: organisationRequest.support_phone,
      chat_icon_color: organisationRequest.chat_icon_color,
      chat_bubble_color: organisationRequest.chat_bubble_color,
      chat_text_color: organisationRequest.chat_text_color,
      fine_tuning_filename: organisationRequest.fine_tuning_filename,
    };
    await db
      .insertInto("organisations")
      .values(organisationToSave)
      .executeTakeFirst();

    if (!organisationRequest.assistant_id) {
      // Create a new assistant using OpenAI's JS SDK
      try {
        const assistant_id = await createAssistant(
          organisationToSave.id,
          organisationRequest.name,
          organisationRequest.description,
          organisationRequest.fine_tuning_data
        );
        // save assistant ID to org
        await db
          .updateTable("organisations")
          .set({ assistant_id })
          .where("id", "=", organisationToSave.id)
          .execute();
      } catch (e) {
        context.error(`Failed to create assistant in OpenAI: ${e.message}`);
      }
    }

    const jsonBody = await getOrganisation(organisationToSave.id);
    return { status: 200, jsonBody };
  } catch (e) {
    console.error(e);
    return {
      status: 500,
      jsonBody: {
        error: `Can't create organisation`,
      },
    };
  }
}

app.http("createOrganisation", {
  methods: ["POST"],
  route: "organisations",
  authLevel: "anonymous",
  handler: createOrganisation,
});
