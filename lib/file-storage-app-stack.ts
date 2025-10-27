import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as path from "path";
import * as iam from "aws-cdk-lib/aws-iam";
import * as targets from "aws-cdk-lib/aws-events-targets";

import * as events from "aws-cdk-lib/aws-events";
import { Construct } from "constructs";

export class FileStorageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 🔒 S3 Bucket privé
    const fileBucket = new s3.Bucket(this, "FileStorageBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      //
      enforceSSL: true,
      lifecycleRules: [
        {
          // Deletes unconfirmed items after 7 days
          expiration: cdk.Duration.days(7),
          prefix: "", // applies to the entire bucket
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: [
            "http://localhost:5173",
            "http://localhost:5174",
            "https://d8sf8xsuwlte.cloudfront.net",
          ],
          allowedHeaders: ["*"],
        },
      ],
      eventBridgeEnabled: true, //  Enables EventBridge events
    });

    // EventBridge rule: trigger MediaConverterFunction when an object is created
    const mediaConverterRule = new events.Rule(this, "MediaConverterRule", {
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: { name: [fileBucket.bucketName] },
        },
      },
    });

    // 🗃️ DynamoDB Table
    const fileTable = new dynamodb.Table(this, "FileMetadataTable", {
      partitionKey: { name: "fileId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ⚙️ Lambda 1: Upload & API Handler
    const uploadHandler = new lambda.Function(this, "UploadHandlerFunction", {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../lambda/upload-handler"),
        {
          bundling: {
            image: lambda.Runtime.NODEJS_20_X.bundlingImage,
            command: [
              "bash",
              "-c",
              "npm ci  --cache /tmp/empty-cache && npm run build && cp -r . /asset-output",
            ],
          },
        }
      ),
      environment: {
        BUCKET_NAME: fileBucket.bucketName,
        TABLE_NAME: fileTable.tableName,
      },
      timeout: cdk.Duration.seconds(10),
    });

    // ⚙️ Lambda 2: Metadata Updater (événement S3)
    const metadataUpdater = new lambda.Function(
      this,
      "MetadataUpdaterFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../lambda/metadata-updater"),
          {
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              command: [
                "bash",
                "-c",
                "npm ci  --cache /tmp/empty-cache && npm run build && cp -r . /asset-output",
              ],
            },
          }
        ),
        environment: {
          TABLE_NAME: fileTable.tableName,
        },
        timeout: cdk.Duration.seconds(10),
      }
    );

    // 🔐 Permissions
    fileBucket.grantReadWrite(uploadHandler);
    fileTable.grantReadWriteData(uploadHandler);

    fileBucket.grantRead(metadataUpdater); // Pour lire les métadonnées S3
    fileTable.grantWriteData(metadataUpdater);

    // 🔔 Déclencheur S3 → Metadata Updater
    fileBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(metadataUpdater)
    );

    // create the layer FFmpeg
    const ffmpegLayer = new lambda.LayerVersion(this, "FFmpegLayer", {
      code: lambda.Code.fromAsset(path.join(__dirname, "../layers/ffmpeg")),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: "FFmpeg binary for media processing",
    });

    // 🖼️ Lambda: Media Thumbnail Generator
    const mediaConverterFunction = new lambda.Function(
      this,
      "MediaConverterFunction",
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../lambda/media-converter"),
          {
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              command: [
                "bash",
                "-c",
                "npm ci  --cache /tmp/empty-cache && npm run build && cp -r . /asset-output",
              ],
            },
          }
        ),
        layers: [ffmpegLayer],
        environment: {
          // FFMPEG_PATH: "/opt/nodejs/node_modules/ffmpeg-static/ffmpeg",
          // FFPROBE_PATH:
          //   "/opt/nodejs/node_modules/ffprobe-static/bin/linux/x64/ffprobe",
          // PATH: "/opt/nodejs/node_modules/ffmpeg-static/:/opt/nodejs/node_modules/ffprobe-static/bin/linux/x64:/opt/bin:/usr/local/bin:/usr/bin/:/bin:/opt/nodejs/bin",
          // LD_LIBRARY_PATH: "/opt/lib:/usr/lib:/lib",
          BUCKET_NAME: fileBucket.bucketName,
          THUMBNAIL_PREFIX: "thumbnails/",
        },
        timeout: cdk.Duration.minutes(2), // FFmpeg can be slow
        memorySize: 1024, // More memory = faster FFmpeg
      }
    );

    // 🔐 Permissions
    fileBucket.grantReadWrite(mediaConverterFunction);
    fileTable.grantWriteData(mediaConverterFunction);

    // Cible : MediaConverterFunction
    mediaConverterRule.addTarget(
      new targets.LambdaFunction(mediaConverterFunction)
    );

    // Grant permission to EventBridge to invoke the Lambda
    mediaConverterFunction.addPermission(
      "MediaConverterEventBridgePermission",
      {
        principal: new iam.ServicePrincipal("events.amazonaws.com"),
        sourceArn: mediaConverterRule.ruleArn,
      }
    );

    // 🌐 API Gateway (mode proxy partout)
    const api = new apigw.RestApi(this, "FileStorageApi", {
      restApiName: "File Storage Service",
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    // Routes
    const uploadUrlResource = api.root.addResource("upload-url");
    uploadUrlResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(uploadHandler)
    );

    const filesResource = api.root.addResource("files");
    filesResource.addMethod("GET", new apigw.LambdaIntegration(uploadHandler));

    const fileResource = filesResource.addResource("{fileId}");
    fileResource.addMethod("GET", new apigw.LambdaIntegration(uploadHandler)); // /files/{id}/download
    fileResource.addMethod(
      "DELETE",
      new apigw.LambdaIntegration(uploadHandler)
    );

    // Sous-ressource pour /files/{fileId}/thumbnail
    const thumbnailResource = fileResource.addResource("thumbnail");
    thumbnailResource.addMethod(
      "GET",
      new apigw.LambdaIntegration(uploadHandler)
    );
  }
}
