import * as Blockly from "blockly/core"
import { registerTurtleBlocks } from "./blocks"

export function serializeWorkspaceToXml(workspace: Blockly.Workspace): string {
  const xml = Blockly.Xml.workspaceToDom(workspace)
  return Blockly.Xml.domToText(xml)
}

export function deserializeWorkspaceFromXml(workspace: Blockly.Workspace, xmlText: string): void {
  registerTurtleBlocks()
  workspace.clear()

  const trimmedXml = xmlText.trim()
  if (trimmedXml.length === 0) {
    return
  }

  const xml = Blockly.utils.xml.textToDom(trimmedXml)
  Blockly.Xml.domToWorkspace(xml, workspace)
}

export function createWorkspaceFromXml(xmlText = ""): Blockly.Workspace {
  const workspace = new Blockly.Workspace()
  deserializeWorkspaceFromXml(workspace, xmlText)
  return workspace
}
