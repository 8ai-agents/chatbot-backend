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
import { createAssistant } from "../openAIHandler";

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

    if (!organisationRequest.assistant_id) {
      // Create a new assistant using OpenAI's JS SDK
      try {
        const assistant_id = await createAssistant(
          organisationRequest.name,
          organisationRequest.fine_tuning_filename,
          organisationRequest.fine_tuning_data
        );
        organisationRequest.assistant_id = assistant_id;
      } catch (e) {
        context.error(`Failed to create assistant in OpenAI: ${e.message}`);
      }
    }

    context.log(`Creating organisation ${organisationRequest.name}`);
    const organisationToSave: NewOrganisation = {
      ...organisationRequest,
      id: createID("org"),
    };
    await db
      .insertInto("organisations")
      .values(organisationToSave)
      .executeTakeFirst();

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
