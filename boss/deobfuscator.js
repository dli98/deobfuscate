const esprima = require('esprima');
const estraverse = require('estraverse');
const escodegen = require('escodegen');
const fs = require("fs");

const base64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split("");
const base64inv = {};
for (let i = 0; i < base64chars.length; i++) {
    base64inv[base64chars[i]] = i;
}


function base64_decode(s) {
    let base64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // remove/ignore any characters not in the base64 characters list
    //  or the pad character -- particularly newlines
    s = s.replace(new RegExp('[^' + base64chars.split("") + '=]', 'g'), "");

    // replace any incoming padding with a zero pad (the 'A' character is zero)
    let p = (s.charAt(s.length - 1) == '=' ?
        (s.charAt(s.length - 2) == '=' ? 'AA' : 'A') : "");
    let r = "";
    s = s.substr(0, s.length - p.length) + p;

    // increment over the length of this encoded string, four characters at a time
    for (let c = 0; c < s.length; c += 4) {

        // each of these four characters represents a 6-bit index in the base64 characters list
        //  which, when concatenated, will give the 24-bit number for the original 3 characters
        let n = (base64inv[s.charAt(c)] << 18) + (base64inv[s.charAt(c + 1)] << 12) +
            (base64inv[s.charAt(c + 2)] << 6) + base64inv[s.charAt(c + 3)];

        // split the 24-bit number into the original three 8-bit (ASCII) characters
        r += String.fromCharCode((n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    }
    // remove any zero pad that was added to make this a multiple of 24 bits
    return r.substring(0, r.length - p.length);
}

function shouldSwitchScope(node) {
    return node.type.match(/^Function(Express|Declarat)ion$/);
}

function mergeFunction(ast, letname) {
    ast = estraverse.replace(ast, {
        enter: function (node) {
        },
        leave: function (node, parent) {
            // 全局对象中存的是字符串
            if (node.type === esprima.Syntax.MemberExpression
                && letname.hasOwnProperty(node.object.name)
            ) {
                const key = node.object.name;
                const value = node.property.name;

                if (letname[key].hasOwnProperty(value)) {
                    let property = letname[key][value];
                    if (property.value.type === esprima.Syntax.FunctionExpression) {

                    } else if (property.value.type === esprima.Syntax.Literal) {
                        const val = letname[key][value].value.value;
                        return {
                            type: esprima.Syntax.Literal,
                            value: val,
                            raw: val
                        }
                    }
                }

            }
            // 全局对象中存的是函数
            if (node.type === esprima.Syntax.CallExpression
                && node.callee.type === esprima.Syntax.MemberExpression
            ) {
                let subNode = node.callee;
                if (subNode.type === esprima.Syntax.MemberExpression
                    && letname.hasOwnProperty(subNode.object.name)
                ) {

                    const key = subNode.object.name;
                    const value = subNode.property.name;
                    let property = letname[key][value];
                    // console.log(escodegen.generate(node));
                    if (property.value.type === esprima.Syntax.FunctionExpression) {
                        // 实参
                        let arguments = [];
                        for (let i = 0; i < node.arguments.length; i++) {
                            arguments.push(node.arguments[i])
                        }

                        // 形参
                        let parameter = [];
                        for (let i = 0; i < property.value.params.length; i++) {
                            parameter.push(property.value.params[i].name)
                        }

                        let blockStatement = property.value.body;
                        let returnStatement = blockStatement.body[0];

                        // 函数返回结果
                        let result = JSON.parse(JSON.stringify(returnStatement.argument));

                        // 结果替换 ==> 更换所有Identifier为实参Identifier
                        if (result.type === esprima.Syntax.CallExpression) {
                            result.callee = arguments[parameter.indexOf(result.callee.name)];
                            if (result.arguments.length === 0) {
                                result.arguments = []
                            }
                            for (let i = 0; i < result.arguments.length; i++) {
                                result.arguments[i] = arguments[parameter.indexOf(result.arguments[i].name)];
                            }

                        } else if (result.type === esprima.Syntax.BinaryExpression) {
                            result.left = arguments[parameter.indexOf(result.left.name)];
                            result.right = arguments[parameter.indexOf(result.right.name)];
                        }
                        return result
                    }
                }
            }
        }
    });
    return ast;
}

function functionDeobfuscator(ast) {
    let letname = {};
    let scopeDepth = 0; // initial: global

    ast = estraverse.replace(ast, {
        enter: function (node) {
            if (shouldSwitchScope(node)) {
                scopeDepth++;
            }
            letname = {};

            // pass 1 找到函数map
            if (node.type === esprima.Syntax.FunctionDeclaration
                || node.type === esprima.Syntax.FunctionExpression
            ) {
                let blockStatement = node.body;
                if (blockStatement.body.length <= 1) {
                    return;
                }
                let VariableDeclaration = blockStatement.body[0];
                if (VariableDeclaration.type !== esprima.Syntax.VariableDeclaration) {
                    return
                }
                let declarations = VariableDeclaration.declarations;
                let VariableDeclarator = declarations[0];

                // 1.1 存储函数map
                if (VariableDeclarator.init
                    && VariableDeclarator.init.type === esprima.Syntax.ObjectExpression) {
                    letname[VariableDeclarator.id.name] = {};
                    let properties = VariableDeclarator.init.properties;
                    for (let i = 0; i < properties.length; i++) {
                        const property = properties[i];
                        const name = property.key.value;
                        letname[VariableDeclarator.id.name][name] = JSON.parse(JSON.stringify(property))
                    }
                    //1.2 删除变量声明
                    blockStatement.body.splice(0, 1);
                    this.skip()
                }
            }
        }
        ,
        // pass 2 全局对象赋值。重新导入代码。
        leave: function (node) {
            if (shouldSwitchScope(node)) {
                scopeDepth--;
            }
            if (Object.keys(letname).length !== 0) {
                mergeFunction(node, letname);
            }
        }
    });
    return ast
}

let isWhileCase = function (ast) {
    const whileStatement = ast;
    if (whileStatement && whileStatement.type !== esprima.Syntax.WhileStatement) {
        return false
    }
    const blockStatement = whileStatement.body;
    const switchStatement = blockStatement.body[0];

    return !(switchStatement && switchStatement.type !== esprima.Syntax.SwitchStatement);

};

function mergeCases(ast, sequence) {
    const blockStatement = ast.body;
    const switchStatement = blockStatement.body[0];
    let cases = switchStatement.cases;

    let memberAccessSequence = [];
    // case顺序排序
    for (let i = 0; i < sequence.length; i++) {
        memberAccessSequence.push(cases[sequence[i]])
    }

    // 合并case
    let body = [];
    for (let i = 0; i < memberAccessSequence.length; i++) {
        let switchCases = memberAccessSequence[i];
        for (let j = 0; j < switchCases.consequent.length; j++) {
            // 删除continueStatement 语句
            let consequent = switchCases.consequent[j];
            if (consequent.type !== esprima.Syntax.ContinueStatement) {
                body.push(consequent)
            }
        }
    }

    return body
}


function switchCaseDeobfuscator(ast) {
    estraverse.traverse(ast, {
        enter: function (node, parent) {
            if (isWhileCase(node)) {
                let body = parent.body[0];
                // whileCase执行顺序
                let sequence = body.declarations[0].init.callee.object.value;
                if (!sequence) {
                    return
                }
                sequence = sequence.split("|");
                // 反混淆之后的body
                body = mergeCases(node, sequence);
                parent.body = body;
                this.skip()
            }
        }
    });
    return ast
}

function stringDeobfuscator(ast) {
    // pass 1: extract all strings
    let strings = {};
    let letiable = ast.body[0].declarations[0];
    // 全局字符串列表变量名
    const stringsName = letiable.id.name;
    strings[stringsName] = letiable.init.elements.map(function (e) {
        return base64_decode(e.value);
    });

    let letname = ast.body[1].expression.arguments[0].name;
    let count = ast.body[1].expression.arguments[1].value;
    count = count + 1;
    while (--count) {
        strings[letname]['push'](strings[letname]['shift']());
    }

    // pass 2: restore code

    // 字符串混淆函数名
    const StrdeobfuscatorFunctionName = ast.body[2].declarations[0].id.name;

    if (Object.keys(strings).length === 0) {
        return ast
    }
    estraverse.replace(ast, {
        enter: function (node) {
        },
        leave: function (node) {
            // restore strings
            if (node.type === esprima.Syntax.MemberExpression &&
                node.computed &&
                strings.hasOwnProperty(node.object.name) &&
                node.property.type === esprima.Syntax.Literal &&
                typeof node.property.value === 'number'
            ) {
                let val = strings[node.object.name][node.property.value];
                if (val) {
                    return {
                        type: esprima.Syntax.Literal,
                        value: val,
                        raw: val
                    }
                }

            }

            // []调用改为 .调用
            if (node.type === esprima.Syntax.MemberExpression &&
                node.property.type === esprima.Syntax.Literal &&
                typeof node.property.value === 'string'
            ) {
                return {
                    type: esprima.Syntax.MemberExpression,
                    computed: false,
                    object: node.object,
                    property: {
                        type: esprima.Syntax.Identifier,
                        name: node.property.value
                    }
                }
            }

            // 字符串反混淆
            if (node.type === esprima.Syntax.CallExpression &&
                node.callee.name === StrdeobfuscatorFunctionName
            ) {
                let idx = Number(node.arguments[0].value);
                let val = strings[stringsName][idx];
                return {
                    type: esprima.Syntax.Literal,
                    value: val,
                    raw: val
                }
            }
        }
    });

    return ast

}

function iswhile1(ast) {
    // 判断是否为while(1) 混淆
    return ast.type === esprima.Syntax.WhileStatement
        && ast.test.type === esprima.Syntax.Literal
        && ast.test.value === 1;

}

function generateUnaryExpression(argument, operator) {
    return {
        "type": esprima.Syntax.UnaryExpression,
        "operator": operator,
        "argument": argument,
        "prefix": true
    };
}

function handleIfBreak() {

}

function handleElseBreak() {

}

function while1ToFor(whileStatement, parent) {
    let init;
    let parentBodyLine = 0;
    for (let i = 0; i < parent.length; i++) {
        if (iswhile1(parent[i])) {
            init = parent[i - 1];
            parentBodyLine = i + 1;
        }
    }

    let blockStatementBody = whileStatement.body.body;
    let test, update;
    let bodyLine = 0;
    let body = [];
    let ifCount = 0;
    for (let i = blockStatementBody.length - 1; i > 0; i--) {
        bodyLine += 1;
        // 找到最后一个for 循环 test 和 update
        if (blockStatementBody[i].type === esprima.Syntax.IfStatement
            && blockStatementBody[i].consequent
        ) {
            ifCount += 1;
            // console.log(blockStatementBody[i].consequent.body[0].label);
            // 有 else
            if (blockStatementBody[i].alternate) {
                test = blockStatementBody[i].test;
                update = blockStatementBody[i - 1].expression;

                body = JSON.parse(JSON.stringify(blockStatementBody.slice(0, blockStatementBody.length - bodyLine)));

                let ifBody, elseBody;
                ifBody = blockStatementBody[i].consequent.body;
                elseBody = blockStatementBody[i].alternate.body;
                if (ifBody[ifBody.length - 1].type === esprima.Syntax.BreakStatement) {
                    return;
                    // else 中的语句加入body中
                    // elseBody.map(e => body.push(e));
                    // // if 中的语句加入到parent的body中
                    // ifBody.map(function (e) {
                    //     if (e.type !== esprima.Syntax.BreakStatement){
                    //         parent.splice(parentBodyLine, 0, e);
                    //         parentBodyLine += 1;
                    //     }
                    // });
                }
                else if (elseBody[elseBody.length - 1].type === esprima.Syntax.BreakStatement) {
                    // if 中的语句加入body中
                    ifBody.map(e => body.push(e));

                    // else 中的语句加入到parent的body中
                    elseBody.map(function (e) {
                        if (e.type !== esprima.Syntax.BreakStatement) {
                            parent.splice(parentBodyLine, 0, e);
                            parentBodyLine += 1;
                        }
                    });
                }
            }

            // if 直接break。 没有else
            else if (blockStatementBody[i].consequent.body[0].type === esprima.Syntax.BreakStatement
                // 不是labelStatement 跳转
                && !blockStatementBody[i].consequent.body[0].label
            ) {
                test = blockStatementBody[i].test;
                // 二元表表达式 取反
                if (test.type === esprima.Syntax.BinaryExpression) {
                    test = generateUnaryExpression(test, "!")
                }
                else {
                    test = test.argument;
                }
                body = JSON.parse(JSON.stringify(blockStatementBody.slice(0, blockStatementBody.length - bodyLine)))
            }

            // 找到if语句之后就结束循环
            break

        }
        // 最后一个为if语句才进行反混淆
        break
    }
    if (test) {
        return {
            type: esprima.Syntax.WhileStatement,
            test: test,
            body: {
                type: esprima.Syntax.BlockStatement,
                body: body
            },

        };
    }

}

function while1Deobfuscator(ast) {

    ast = estraverse.replace(ast, {
        enter: function (node, parent) {
            if (iswhile1(node)) {
                // console.log(escodegen.generate(parent));
                // console.log("返现while1混淆");
                return while1ToFor(node, parent.body)
            }
        },
        leave: function (node) {

        }
    });
    return ast
}

function Deobfuscator(ast) {
    // pass 1: 字符串全局反混淆
    ast = stringDeobfuscator(ast);
    let tmpbody = ast.body.splice(0, 2);

    // pass 3: 函数字典map
    ast = functionDeobfuscator(ast);
    ast.body.splice(0, 0, tmpbody[1]);
    ast.body.splice(0, 0, tmpbody[0]);

    // pass 4: 控制流整平反混淆
    ast = switchCaseDeobfuscator(ast);
    ast = switchCaseDeobfuscator(ast);

    // pass 5: while(1) break 反混淆
    // while1Deobfuscator(ast);

}

function writeBeautifulJs(ast, fileName) {
    fs.writeFile(fileName, escodegen.generate(ast), "utf8", function (error) {
        if (error) {
            console.log(error);
            return false
        }
    })
}

function main(fileName) {
    let code = fs.readFileSync(fileName).toString();
    let ast = esprima.parse(code);
    Deobfuscator(ast);

    fileName = "boss/413c10e2bossBeautiful.js";
    writeBeautifulJs(ast, fileName)
}

// main(process.argv[2]);
// main("boss/test.js");
// main("boss/boss.js");
// main("boss/beautiful.js");
main("boss/413c10e2.js");
