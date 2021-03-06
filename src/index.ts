import Project, { InterfaceDeclaration, PropertySignature, Type } from 'ts-simple-ast'
import { flatMap } from "lodash"
import { BaseError } from "make-error"

// -- Error types --

class UnsupportedPropertyError extends BaseError {
    property: PropertySignature

    constructor(property: PropertySignature) {
        super(`Unsupported property: ${property.getName()}`)
        this.property = property;
    }
}

// -- Helpers --

function outFilePath(sourcePath: string) {
    return sourcePath.replace(/\.(ts|tsx|d\.ts)$/, "\.guard.ts")
}

// -- Main program --

const tab = `    `;
const indentPrefix = [
    ``,
    `${tab}`,
    `${tab}${tab}`,
    `${tab}${tab}${tab}`,
]

function indent(code: string, tabCount: number) {
    if (tabCount >= indentPrefix.length) {
        throw new TypeError(`tabCount >= ${indentPrefix.length}`)
    }
    const result = code.split("\n").map(line =>
        line.trim().length === 0
            ? ""
            : `${indentPrefix[tabCount]}${line}`
    ).join('\n')
    return result
}

function ands(...statements: string[]): string {
    return statements.join(" && \n")
}

function not(a: string, b: string): string {
    return `${a} !== ${b}`
}

function notTypeOf(varName: string, type: string): string {
    return not(`typeof ${varName}`, `"${type}"`)
}

function isNotTypesConditions(varName: string, types: ReadonlyArray<Type>): string[] {
    return flatMap(types, type => isNotTypeConditions(varName, type))
}

function isNotTypeConditions(varName: string, type: Type): string[] {
    if (type.isUnion()) {
        return isNotTypesConditions(varName, type.getUnionTypes())
    }
    if (type.isIntersection()) {
        return isNotTypesConditions(varName, type.getIntersectionTypes())
    }
    if (type.isArray()) {
        return [
            `!Array.isArray(${varName})`,
            `${varName}.length > 0`,
            ...isNotTypeConditions(`${varName}[0]`, type.getArrayType()!),
        ]
    }
    if (type.isInterface()) {
        return [`!${isInterfaceFunctionNames.get(type)}(${varName})`]
    }
    if (type.isObject()) {
        return [notTypeOf('obj', "object")]
    }
    if (type.isLiteral()) {
        return [not(varName, type.getText())]
    }
    return [notTypeOf(varName, type.getText())]
}

function isPropertyIfStatement(property: PropertySignature): string {
    const conditions: string[] = [];
    const varName = `obj.${property.getName()}`;
    if (property.hasQuestionToken()) {
        conditions.push(notTypeOf(varName, "undefined"))
    }

    conditions.push(...isNotTypeConditions(varName, property.getType()))

    if (conditions.length === 0) {
        throw new UnsupportedPropertyError(property);
    }
    return `
    if (
${indent(ands(...conditions), 2)}
    ) {
        return false;
    }
`;
}

const isInterfaceFunctionNames = new WeakMap<Type, string>()

function processInterface(iface: InterfaceDeclaration): string {
    const interfaceName = iface.getName();
    const functionName = `is${interfaceName}`;
    const type = iface.getType();
    isInterfaceFunctionNames.set(type, functionName);

    // TODO: Assert object interface

    const statements: string[] = [`
    if (${notTypeOf('obj', "object")}) {
        return false;
    }
`]

    for (const property of iface.getProperties()) {
        try {
            statements.push(isPropertyIfStatement(property))
        } catch (error) {
            if (error instanceof UnsupportedPropertyError) {
                console.error(`WARNING: ${interfaceName}.${property.getName()} unsupported`)
                continue;
            }
            throw error
        }
    }
    return `
export function ${functionName}(obj: any): obj is ${interfaceName} {
    ${statements.join("\n")}
    return true;
}
`
}

// -- Process input --

const paths = process.argv.slice(2)
if (paths.length === 0) {
    console.error(`specify some files`)
    process.exit(1);
}

// -- Process project --

const project = new Project()
project.addExistingSourceFiles(paths)

project.getSourceFiles().forEach(sourceFile => {
    const interfaces = sourceFile.getInterfaces()
    let defaultImport: InterfaceDeclaration | undefined
    const imports: InterfaceDeclaration[] = []
    const functions = interfaces.reduce((acc, iface) => {
        if (iface.isExported()) {
            if (iface.isDefaultExport()) {
                defaultImport = iface
            } else {
                imports.push(iface)
            }
            acc.push(processInterface(iface))
        }
        return acc
    }, [] as string[])

    if (functions.length > 0) {
        const outPath = outFilePath(sourceFile.getFilePath())
        let outFile = project.getSourceFile(outPath)
        if (outFile) {
            outFile.removeText()
        } else {
            outFile = project.createSourceFile(outPath)
        }
        outFile.addStatements(functions.join('\n'))

        outFile.addImportDeclaration({
            defaultImport: defaultImport && defaultImport.getName(),
            moduleSpecifier: sourceFile.getRelativePathAsModuleSpecifierTo(sourceFile),
            namedImports: imports.map(i => i.getName())
        })
    }
})

project.save().then(() => {
    console.log("Done!")
}).catch(error => {
    console.error(error)
})
