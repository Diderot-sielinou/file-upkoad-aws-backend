import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from "uuid";

const s3Client = new S3Client();
const dynamoClient = new DynamoDBClient();

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const isValidFileName = (name: string): boolean => {
  return name.length > 0 && name.length <= 255 && !name.includes("/");
};

const isValidContentType = (type: string): boolean => {
  return /^[\w\-\+\.\/]+$/.test(type) && type.length <= 100;
};

const createResponse = (
  statusCode: number,
  body: Record<string, unknown> | string,
  extraHeaders: Record<string, string> = {}
): APIGatewayProxyResult => {
  const isString = typeof body === "string";
  return {
    statusCode,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: isString ? body : JSON.stringify(body),
  };
};

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // Manage OPTIONS requests (CORS preflight)
  if (event.httpMethod === "OPTIONS") {
    return createResponse(200, {});
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    if (method === "GET" && path === "/upload-url") {
      const fileName = event.queryStringParameters?.fileName;
      const contentType = event.queryStringParameters?.contentType;

      if (!fileName || !contentType) {
        return createResponse(400, {
          error: "fileName and contentType are required",
        });
      }

      if (!isValidFileName(fileName) || !isValidContentType(contentType)) {
        return createResponse(400, {
          error: "Invalid fileName or contentType",
        });
      }

      const fileId = uuidv4();
      const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: fileId,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="${encodeURIComponent(
          fileName
        )}"`,
      };

      const uploadUrl = await getSignedUrl(
        s3Client,
        new PutObjectCommand(uploadParams),
        { expiresIn: 3600 }
      );

      await dynamoClient.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            fileId: { S: fileId },
            fileName: { S: fileName },
            contentType: { S: contentType },
            status: { S: "pending" },
            createdAt: { S: new Date().toISOString() },
          },
        })
      );

      return createResponse(200, { fileId, uploadUrl });
    }

    // GET /files/{fileId}/thumbnail
    if (method === "GET" && path.endsWith("/thumbnail")) {
      const fileId = event.pathParameters?.fileId;
      if (!fileId) {
        return createResponse(400, { error: "fileId is required" });
      }

      // Thumbnail key in S3
      const thumbnailKey = `thumbnails/${fileId}.jpg`;

      try {
        const downloadUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: BUCKET_NAME, Key: thumbnailKey }),
          { expiresIn: 3600 } // 1 heure
        );

        return createResponse(200, { thumbnailUrl: downloadUrl });
      } catch (error) {
        console.error("Thumbnail fetch error:", error);
        return createResponse(404, { error: "Thumbnail not found" });
      }
    }

    // GET /files
    if (method === "GET" && path === "/files") {
      const result = await dynamoClient.send(
        new ScanCommand({ TableName: TABLE_NAME, Limit: 50 })
      );
      const items = (result.Items || []).map((item) => ({
        fileId: item.fileId?.S,
        fileName: item.fileName?.S,
        contentType: item.contentType?.S,
        status: item.status?.S,
        createdAt: item.createdAt?.S,
        uploadedAt: item.uploadedAt?.S,
        fileSize: item.fileSize ? parseInt(item.fileSize.N!) : undefined,
      }));

      return createResponse(200, { items });
    }

    // GET /files/{fileId}  génère download URL
    if (method === "GET" && path.startsWith("/files/")) {
      const fileId = event.pathParameters?.fileId;
      if (!fileId) {
        return createResponse(400, { error: "fileId required" });
      }

      const downloadParams = { Bucket: BUCKET_NAME, Key: fileId };
      try {
        const downloadUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand(downloadParams),
          { expiresIn: 3600 }
        );
        return createResponse(200, { downloadUrl });
      } catch (error) {
        console.error("Download error:", error);
        return createResponse(404, { error: "File not found" });
      }
    }

    // DELETE /files/{fileId}
    if (method === "DELETE" && path.startsWith("/files/")) {
      const fileId = event.pathParameters?.fileId;
      if (!fileId) {
        return createResponse(400, { error: "fileId required" });
      }

      await s3Client.send(
        new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: fileId })
      );
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: { fileId: { S: fileId } },
        })
      );

      return createResponse(200, { message: "File deleted" });
    }

    return createResponse(404, { error: "Not found" });
  } catch (error: any) {
    console.error("Lambda error:", error);
    return createResponse(500, { error: "Internal server error" });
  }
};
