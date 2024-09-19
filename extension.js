// @ts-nocheck
const vscode = require('vscode'); // Import the Visual Studio Code API
const fs = require('fs').promises; // Import the file system module with promise support
const path = require('path'); // Import the path module for handling file paths
const ignore = require('ignore'); // Import the ignore module to handle ignore patterns
const isBinaryFile = require('isbinaryfile').isBinaryFile; // Import function to check if a file is binary
const { tokenizeAndEstimateCost } = require('llm-cost'); // Import function to tokenize content and estimate LLM costs

// Define the maximum number of tokens allowed for different models
const MODEL_MAX_TOKENS = {
    "gpt-4": 8192,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "claude-3-5-sonnet-20240620": 200000,
    "claude-3-opus-20240229": 200000
};

/**
 * Activates the extension and registers the 'contx.copyToClipboard' command.
 * @param {vscode.ExtensionContext} context - The extension context
 */
function activate(context) {
    // Register the command 'contx.copyToClipboard'
    let disposable = vscode.commands.registerCommand('contx.copyToClipboard', async (uri, uris) => {
        try {
            // Retrieve configuration settings from the 'contx' namespace
            const config = vscode.workspace.getConfiguration('contx');
            const ignoreGitIgnore = config.get('ignoreGitIgnore');
            const maxDepth = config.get('maxDepth');
            const excludePatterns = config.get('excludePatterns');
            const outputFormat = config.get('outputFormat');
            const maxFileSize = config.get('maxFileSize') || 1024 * 1024; // Default to 1MB
            const includeProjectTree = config.get('includeProjectTree') || true;
            const compressCode = config.get('compressCode') || false;
            const removeComments = config.get('removeComments') || false;
            const llmModel = config.get('llmModel') || 'gpt-4';
            const maxTokens = config.get('maxTokens');
            const enableTokenWarning = config.get('enableTokenWarning');
            const enableTokenCounting = config.get('enableTokenCounting') || false;
            const defaultOrder = "Please review the 'File Contents' provided above. Add comprehensive comments to explain the functionality of each function and key code blocks. Additionally, suggest any improvements or optimizations to enhance the code quality, performance, or maintainability.";

            // Determine the items to process based on user selection
            const itemsToProcess = uris && uris.length > 0 ? uris : [uri];

            if (itemsToProcess.length > 0) {
                // Get the workspace folder of the first selected item
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(itemsToProcess[0]);
                if (workspaceFolder) {
                    // Initialize ignore patterns
                    // @ts-ignore
                    const ig = ignore().add(excludePatterns);
                    ig.add('.*'); // Ignore dot files

                    // If configured, add rules from .gitignore
                    if (ignoreGitIgnore) {
                        await addGitIgnoreRules(workspaceFolder.uri.fsPath, ig);
                    }

                    // Generate the project tree if required
                    let projectTree = includeProjectTree ? await getProjectTree(workspaceFolder.uri.fsPath, ig, maxDepth) : '';
                    let processedContent = [];

                    // Iterate over each selected item (file or directory)
                    for (const item of itemsToProcess) {
                        const stats = await fs.stat(item.fsPath);
                        if (stats.isDirectory()) {
                            // Process directories recursively
                            processedContent.push(...await processDirectory(item.fsPath, workspaceFolder.uri.fsPath, ig, maxFileSize, compressCode, removeComments));
                        } else {
                            // Process individual files
                            const fileContent = await processFile(item.fsPath, workspaceFolder.uri.fsPath, ig, maxFileSize, compressCode, removeComments);
                            if (fileContent) processedContent.push(fileContent);
                        }
                    }

                    // Format the collected content based on the selected output format
                    const formattedContent = formatOutput(outputFormat, projectTree, processedContent, defaultOrder);

                    if (enableTokenCounting) {
                        // Tokenize the content and estimate the cost based on the selected LLM model
                        const { inputTokens, cost } = await tokenizeAndEstimateCost({
                            model: llmModel,
                            input: formattedContent,
                            output: ''
                        });

                        // Copy the formatted content to the clipboard
                        await vscode.env.clipboard.writeText(formattedContent);

                        // Prepare the message to display to the user
                        let message = `Copied to clipboard: ${outputFormat} format, ${inputTokens} tokens, $${cost.toFixed(4)} est. cost`;

                        if (enableTokenWarning) {
                            const tokenLimit = maxTokens !== null ? maxTokens : (MODEL_MAX_TOKENS[llmModel] || 0);
                            if (tokenLimit > 0 && inputTokens > tokenLimit) {
                                // Warn the user if token count exceeds the limit
                                message += `\nWARNING: Token count (${inputTokens}) exceeds the set limit (${tokenLimit}).`;
                                vscode.window.showWarningMessage(message);
                            } else {
                                vscode.window.showInformationMessage(message);
                            }
                        } else {
                            vscode.window.showInformationMessage(message);
                        }
                    } else {
                        // If token counting is disabled, simply copy the content and notify the user
                        await vscode.env.clipboard.writeText(formattedContent);
                        vscode.window.showInformationMessage(`Copied to clipboard: ${outputFormat} format`);
                    }
                } else {
                    throw new Error('Unable to determine workspace folder.');
                }
            } else {
                throw new Error('Please select one or more files or folders in the explorer.');
            }
        } catch (error) {
            // Display error messages to the user
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });

    // Add the disposable command to the extension's subscriptions
    context.subscriptions.push(disposable);
}

/**
 * Adds rules from the .gitignore file to the ignore instance.
 * @param {string} rootPath - The root path of the workspace
 * @param {object} ig - The ignore instance
 */
async function addGitIgnoreRules(rootPath, ig) {
    const gitIgnorePath = path.join(rootPath, '.gitignore');
    try {
        const gitIgnoreContent = await fs.readFile(gitIgnorePath, 'utf8');
        ig.add(gitIgnoreContent);
    } catch (error) {
        console.log('.gitignore not found or not readable:', error.message);
    }
}

/**
 * Recursively generates a project tree structure up to a specified depth.
 * @param {string} dir - The current directory path
 * @param {object} ig - The ignore instance
 * @param {number} maxDepth - The maximum depth to traverse
 * @param {number} currentDepth - The current depth in recursion
 * @param {string} prefix - The prefix for formatting the tree
 * @returns {string} - The formatted project tree
 */
async function getProjectTree(dir, ig, maxDepth, currentDepth = 0, prefix = '') {
    if (currentDepth > maxDepth) return '';

    let result = '';
    try {
        const files = await fs.readdir(dir);
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const filePath = path.join(dir, file);
            const relativePath = path.relative(dir, filePath);

            // Skip ignored files and directories
            if (ig.ignores(relativePath)) continue;

            const stats = await fs.stat(filePath);
            const isLast = i === files.length - 1;
            const branch = isLast ? '└── ' : '├── ';

            result += `${prefix}${branch}${file}\n`;

            // If the item is a directory, recurse into it
            if (stats.isDirectory()) {
                result += await getProjectTree(
                    filePath,
                    ig,
                    maxDepth,
                    currentDepth + 1,
                    prefix + (isLast ? '    ' : '│   ')
                );
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
    }
    return result;
}

/**
 * Processes a directory by iterating through its contents and processing each item.
 * @param {string} dirPath - The path of the directory to process
 * @param {string} rootPath - The root workspace path
 * @param {object} ig - The ignore instance
 * @param {number} maxFileSize - The maximum allowed file size
 * @param {boolean} compressCode - Whether to compress code by removing whitespace
 * @param {boolean} removeComments - Whether to remove comments from code
 * @returns {Array} - An array of processed file contents
 */
async function processDirectory(dirPath, rootPath, ig, maxFileSize, compressCode, removeComments) {
    let content = [];
    try {
        const files = await fs.readdir(dirPath);
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const relativePath = path.relative(rootPath, filePath);

            // Skip ignored files and directories
            if (ig.ignores(relativePath)) continue;

            const stats = await fs.stat(filePath);
            if (stats.isDirectory()) {
                // Recursively process subdirectories
                content.push(...await processDirectory(filePath, rootPath, ig, maxFileSize, compressCode, removeComments));
            } else {
                // Process individual files
                const fileContent = await processFile(filePath, rootPath, ig, maxFileSize, compressCode, removeComments);
                if (fileContent) content.push(fileContent);
            }
        }
    } catch (error) {
        console.error(`Error processing directory ${dirPath}:`, error);
    }
    return content;
}

/**
 * Processes a single file by reading its content, handling size limits, binary checks, and optional content transformations.
 * @param {string} filePath - The path of the file to process
 * @param {string} rootPath - The root workspace path
 * @param {object} ig - The ignore instance
 * @param {number} maxFileSize - The maximum allowed file size
 * @param {boolean} compressCode - Whether to compress code by removing whitespace
 * @param {boolean} removeComments - Whether to remove comments from code
 * @returns {object|null} - An object containing the file path and content or null if ignored
 */
async function processFile(filePath, rootPath, ig, maxFileSize, compressCode, removeComments) {
    const relativePath = path.relative(rootPath, filePath);
    if (ig.ignores(relativePath)) return null;

    try {
        const stats = await fs.stat(filePath);
        if (stats.size > maxFileSize) {
            // Skip files that exceed the maximum size and notify the user
            return {
                path: relativePath,
                content: `[File content not included. Size (${stats.size} bytes) exceeds the maximum allowed size (${maxFileSize} bytes)]`
            };
        }

        // Check if the file is binary
        const isBinary = await isBinaryFile(filePath);
        if (isBinary) {
            return {
                path: relativePath,
                content: '[Binary file content not included]'
            };
        }

        // Read the file content as UTF-8 text
        let fileContent = await fs.readFile(filePath, 'utf8');

        // Optionally remove comments and/or compress code
        if (removeComments || compressCode) {
            fileContent = processContent(fileContent, removeComments, compressCode);
        }

        return {
            path: relativePath,
            content: fileContent
        };
    } catch (error) {
        console.error(`Error processing file ${relativePath}:`, error);
        return {
            path: relativePath,
            content: `[Error reading file: ${error.message}]`
        };
    }
}

/**
 * Processes the content of a file by removing comments and/or compressing code.
 * @param {string} content - The original file content
 * @param {boolean} removeComments - Whether to remove comments
 * @param {boolean} compressCode - Whether to compress code by removing whitespace
 * @returns {string} - The processed content
 */
function processContent(content, removeComments, compressCode) {
    if (removeComments) {
        content = removeCodeComments(content);
    }

    if (compressCode) {
        content = compressCodeContent(content);
    }

    return content;
}

/**
 * Removes single-line and multi-line comments from the code content.
 * @param {string} content - The original code content
 * @returns {string} - The content without comments
 */
function removeCodeComments(content) {
    return content.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');
}

/**
 * Compresses code content by trimming whitespace and removing empty lines.
 * @param {string} content - The original code content
 * @returns {string} - The compressed code content
 */
function compressCodeContent(content) {
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .join('\n');
}

/**
 * Formats the collected project tree and file contents into the specified output format.
 * @param {string} format - The desired output format ('markdown', 'xml', 'plaintext')
 * @param {string} projectTree - The formatted project tree
 * @param {Array} content - The array of processed file contents
 * @param {string} order - The execution order or additional instructions
 * @returns {string} - The formatted output
 */
function formatOutput(format, projectTree, content, order) {
    switch (format) {
        case 'markdown':
            return formatMarkdown(projectTree, content, order);
        case 'xml':
            return formatXML(projectTree, content, order);
        case 'plaintext':
        default:
            return formatPlainText(projectTree, content, order);
    }
}

/**
 * Formats the output in Markdown, including project structure and file contents.
 * @param {string} projectTree - The formatted project tree
 * @param {Array} content - The array of processed file contents
 * @param {string} order - The execution order or additional instructions
 * @returns {string} - The Markdown formatted output
 */
function formatMarkdown(projectTree, content, order) {
    let output = '';
    if (projectTree) {
        output += '# Project Structure\n\n```\n' + projectTree + '```\n\n';
    }
    output += '# File Contents\n\n';
    content.forEach(file => {
        const fileExtension = path.extname(file.path).slice(1);
        const language = fileExtension ? fileExtension : '';
        output += `## ${file.path}\n\n\`\`\`${language}\n${file.content}\n\`\`\`\n\n`;
    });
    if (order) {
        output += '# Execute Order\n```\n' + order + '```\n';
    }
    return output;
}

/**
 * Formats the output in plain text, including project structure and file contents.
 * @param {string} projectTree - The formatted project tree
 * @param {Array} content - The array of processed file contents
 * @param {string} order - The execution order or additional instructions
 * @returns {string} - The plain text formatted output
 */
function formatPlainText(projectTree, content, order) {
    let output = '';
    if (projectTree) {
        output += 'Project Structure:\n\n' + projectTree + '\n\n';
    }
    output += 'File Contents:\n\n';
    content.forEach(file => {
        output += `File: ${file.path}\n\n${file.content}\n\n`;
    });
    if (order) {
        output += 'Execute Order:\n' + order + '\n';
    }
    return output;
}

/**
 * Formats the output in XML, including project structure and file contents.
 * @param {string} projectTree - The formatted project tree
 * @param {Array} content - The array of processed file contents
 * @param {string} order - The execution order or additional instructions
 * @returns {string} - The XML formatted output
 */
function formatXML(projectTree, content, order) {
    let output = '<?xml version="1.0" encoding="UTF-8"?>\n<contx>\n';

    if (projectTree) {
        output += '  <project_structure>\n';
        output += projectTree.split('\n').map(line => '    ' + line).join('\n');
        output += '  </project_structure>\n\n';
    }

    output += '  <file_contents>\n';
    content.forEach(file => {
        output += `    <file path="${escapeXML(file.path)}">\n`;
        output += `      <![CDATA[${file.content}]]>\n`;
        output += '    </file>\n';
    });
    output += '  </file_contents>\n';

    if (order) {
        output += '  <execute_order>\n';
        output += escapeXML(order).split('\n').map(line => '    ' + line).join('\n');
        output += '\n  </execute_order>\n\n';
    }

    output += '</contx>';
    return output;
}

/**
 * Escapes special XML characters in a string.
 * @param {string} unsafe - The string to escape
 * @returns {string} - The escaped string
 */
function escapeXML(unsafe) {
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case "'": return '&apos;';
            case '"': return '&quot;';
        }
    });
}

/**
 * Deactivates the extension. Currently, no cleanup is necessary.
 */
function deactivate() { }

module.exports = {
    activate,
    deactivate
}
