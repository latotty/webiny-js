const { join } = require("path");
const { Component } = require("@serverless/core");
const configureS3Bucket = require("./utils/configureS3Bucket");
const normalizeInputs = require("./utils/normalizeInputs");

/**
 * This component deploys:
 * - S3 bucket for file storage
 * - API GW with "/files/{key}" route
 * - Three functions:
 * - manage files - when a file is deleted, this makes sure all other related files are deleted too
 * - download files - handles file download and calls image transformer if needed
 * - image transformer - performs various image transformations
 */

class FilesComponent extends Component {
    async default(rawInputs = {}) {
        const inputs = normalizeInputs(rawInputs);

        const {
            region,
            bucket,
            storage = {},
            functions: {
                apolloService: apolloServiceInputs,
                downloadFile: downloadFileInputs,
                imageTransformer: imageTransformerInputs
            }
        } = inputs;

        if (!apolloServiceInputs.plugins) {
            apolloServiceInputs.plugins = [];
        }

        const manageFilesLambda = await this.load("@webiny/serverless-function", "manage-files");
        const manageFilesLambdaOutput = await manageFilesLambda({
            region,
            name: this.context.instance.getResourceName("manage-files"),
            timeout: 10,
            code: join(__dirname, "functions/manageFiles"),
            handler: "handler.handler",
            description: `Triggered once a file was deleted.`,
            env: {
                S3_BUCKET: bucket
            }
        });

        // Create S3 bucket for storing files.
        const s3 = await this.load("@serverless/aws-s3");
        const s3Output = await s3({ name: bucket, region, ...storage  });
        await configureS3Bucket({
            component: this,
            s3Output,
            manageFilesLambdaOutput,
            region,
            bucket
        });

        const imageTransformerLambda = await this.load(
            "@webiny/serverless-function",
            "image-transformer"
        );

        const imageTransformerLambdaOutput = await imageTransformerLambda({
            ...imageTransformerInputs,
            region,
            name: this.context.instance.getResourceName("image-transformer"),
            description: `Performs image optimization, resizing, etc.`,
            code: join(__dirname, "functions/imageTransformer"),
            handler: "handler.handler",
            env: {
                ...imageTransformerInputs.env,
                S3_BUCKET: bucket
            }
        });

        // Deploy read/upload lambdas
        const downloadLambda = await this.load("@webiny/serverless-function", "download");
        const downloadLambdaOutput = await downloadLambda({
            ...downloadFileInputs,
            region,
            name: this.context.instance.getResourceName("download-files"),
            description: `Serves previously uploaded files.`,
            code: join(__dirname, "functions/downloadFile"),
            handler: "handler.handler",
            env: {
                ...downloadFileInputs.env,
                S3_BUCKET: bucket,
                IMAGE_TRANSFORMER_LAMBDA_NAME: imageTransformerLambdaOutput.name
            }
        });

        // Deploy graphql API
        const apolloService = await this.load("@webiny/serverless-apollo-service");
        const apolloServiceOutput = await apolloService({
            ...apolloServiceInputs,
            region,
            binaryMediaTypes: ["*/*"],
            endpoints: [
                { path: "/files/{path}", method: "ANY", function: downloadLambdaOutput.arn }
            ],
            env: {
                ...apolloServiceInputs.env,
                S3_BUCKET: bucket,
                DEBUG: apolloServiceInputs.debug || "true",
                UPLOAD_MIN_FILE_SIZE: String(apolloServiceInputs.uploadMinFileSize),
                UPLOAD_MAX_FILE_SIZE: String(apolloServiceInputs.uploadMaxFileSize)
            }
        });

        const output = {
            api: apolloServiceOutput.api,
            s3: s3Output,
            cdnOrigin: {
                url: apolloServiceOutput.api.url,
                pathPatterns: {
                    "/files/*": {
                        ttl: 2592000 // 1 month
                    }
                }
            }
        };

        this.state.output = output;
        await this.save();

        return output;
    }

    async remove() {
        const apolloService = await this.load("@webiny/serverless-apollo-service");
        await apolloService.remove();

        let lambda = await this.load("@webiny/serverless-function", "manage-files");
        await lambda.remove();

        lambda = await this.load("@webiny/serverless-function", "image-transformer");
        await lambda.remove();

        lambda = await this.load("@webiny/serverless-function", "download");
        await lambda.remove();

        // We do not remove S3 bucket; we want to avoid users accidentally deleting all of their files.
        this.context.instance.debug(`Skipping S3 bucket deletion, you must do this manually.`);
        this.state = {};
        await this.save();
    }
}

module.exports = FilesComponent;
