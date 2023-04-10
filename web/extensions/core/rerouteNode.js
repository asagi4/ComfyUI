import { app } from "../../scripts/app.js";

// Node that allows you to redirect connections for cleaner graphs

// Context menu to change input/output orientation
function getOrientationMenu(value, options, e, menu, node) {
	const isInput = value.options.isInput

	new LiteGraph.ContextMenu(
		availableDir,
		{
			event: e,
			parentMenu: menu,
			node: node,
			callback: (dir, options, mouse_event, menu, node) => {
				if (!node) {
					return;
				}
		
				if (isInput) {
					if (node.outputs[0].dir === dir) {
						node.outputs[0].dir = node.inputs[0].dir;
					}
					node.inputs[0].dir = dir;
				} else {
					if (node.inputs[0].dir === dir) {
						node.inputs[0].dir = node.outputs[0].dir;
					}
					node.outputs[0].dir = dir;
				}
				// all inputs must have the same direction
				for (let i = 1; i < node.inputs.length; i++) {
					node.inputs[i].dir = node.inputs[0].dir;
					node.outputs[i].dir = node.outputs[0].dir;
				}
		
				node.applyOrientation();
			}
		}
	);
}

app.registerExtension({
	name: "Comfy.RerouteNode",
	registerCustomNodes() {
		class RerouteNode {
			constructor() {
				if (!this.properties) {
					this.properties = {};
				}
				this.properties.showOutputText = RerouteNode.defaultVisibility;
				// these will already exist if this is a clone; don't double-add
				if (!this.inputs) {
					this.addInput("", "*", {nameLocked: true});
					this.inputs[0].dir = LiteGraph.LEFT;
				}

				if (!this.outputs) {
					this.addOutput("", "*", {nameLocked: true});
					this.outputs[0].dir = LiteGraph.RIGHT;
				}
				

				this.onResize = function(_) {
					this.applyOrientation();
				}

				this.onDrawForeground = function(ctx, graphcanvas, canvas) {
					if (this.properties.showOutputText && graphcanvas.ds.scale > 0.5) {
						ctx.fillStyle = LiteGraph.NODE_TEXT_COLOR;
						ctx.font = graphcanvas.inner_text_font;
						ctx.textAlign = "center";

						ctx.fillText(this.getDisplayName(), this.size[0] / 2, this.size[1] / 2+5);
					}
				}

				this.onConfigure = function(data) {
					
					// update old reroute
					if (!this.inputs[0].dir) { this.inputs[0].dir = LiteGraph.LEFT; }
					if (!this.outputs[0].dir) { this.outputs[0].dir = LiteGraph.RIGHT; }

					if (this.inputs[0].name !== "") { this.inputs[0].name = "" }
					if (this.outputs[0].name !== "") { this.outputs[0].name = "" }

					if (this.inputs[0].label) { delete this.inputs[0].label; }
					if (this.outputs[0].label) { delete this.outputs[0].label; }
					
					if (!this.inputs[0].nameLocked) { this.inputs[0].nameLocked = true }
					if (!this.outputs[0].nameLocked) { this.outputs[0].nameLocked = true }

					// handle old horizontal property
					if (this.properties.horizontal) {
						this.inputs[0].dir = LiteGraph.UP;
						this.outputs[0].dir = LiteGraph.DOWN;
						delete this.properties.horizontal;
					}

					this.applyOrientation();
					app.graph.setDirtyCanvas(true, true);
				}

				this.onConnectionsChange = function (type, index, connected, link_info) {
					this.applyOrientation();

					// Prevent multiple connections to different types when we have no input
					if (connected && type === LiteGraph.OUTPUT) {
						// Ignore wildcard nodes as these will be updated to real types
						const types = new Set(this.outputs[index].links.map((l) => app.graph.links[l].type).filter((t) => t !== "*"));
						if (types.size > 1) {
							for (let i = 0; i < this.outputs[index].links.length - 1; i++) {
								const linkId = this.outputs[index].links[i];
								const link = app.graph.links[linkId];
								const node = app.graph.getNodeById(link.target_id);
								node.disconnectInput(link.target_slot);
							}
						}
					}

					for (let i = 0; i < this.inputs.length; i++) {
						this.resolveTypes(i)
					}
				};

				// This node is purely frontend and does not impact the resulting prompt so should not be serialized
				this.isVirtualNode = true;

				this.applyOrientation();
			}

			resolveTypes(i) {
				let currentNode = this;
				let updateNodes = [];
				let inputType = null;
				let inputNode = null;
				while (currentNode) {
					updateNodes.unshift({node: currentNode, "slot": i});
					const linkId = currentNode.inputs[i].link;
					if (linkId !== null) {
						const link = app.graph.links[linkId];
						const node = app.graph.getNodeById(link.origin_id);
						const type = node.constructor.type;
						if (type === "Reroute") {
							if (node === this) {
								// We've found a circle
								currentNode.disconnectInput(link.target_slot);
								currentNode = null;
							}
							else {
								// Move the previous node
								currentNode = node;
							}
						} else {
							// We've found the end
							inputNode = currentNode;
							inputType = node.outputs[link.origin_slot]?.type ?? null;
							break;
						}
					} else {
						// This path has no input node
						currentNode = null;
						break;
					}
				}

				// Find all outputs
				const nodes = [{node: this, slot: i}];
				let outputType = null;
				while (nodes.length) {
					currentNode = nodes.pop();
					const outputs = (currentNode.node.outputs ? currentNode.node.outputs[currentNode.slot].links : []) || [];
					if (outputs.length) {
						for (const linkId of outputs) {
							const link = app.graph.links[linkId];

							// When disconnecting sometimes the link is still registered
							if (!link) continue;

							const node = app.graph.getNodeById(link.target_id);
							const type = node.constructor.type;

							if (type === "Reroute") {
								// Follow reroute nodes
								nodes.push({node: node, slot: link.target_slot});
								updateNodes.push({node: node, slot: link.target_slot});
							} else {
								// We've found an output
								const nodeOutType = node.inputs && node.inputs[link?.target_slot] && node.inputs[link.target_slot].type ? node.inputs[link.target_slot].type : null;
								if (inputType && nodeOutType !== inputType) {
									// The output doesnt match our input so disconnect it
									node.disconnectInput(link.target_slot);
								} else {
									outputType = nodeOutType;
								}
							}
						}
					} else {
						// No more outputs for this path
					}
				}

				const displayType = inputType || outputType || "*";
				const color = LGraphCanvas.link_type_colors[displayType];

				// Update the types of each node
				for (const nodeslot of updateNodes) {
					const node = nodeslot.node
					const slot = nodeslot.slot;
					// If we dont have an input type we are always wildcard but we'll show the output type
					// This lets you change the output link to a different type and all nodes will update
					node.outputs[slot].type = inputType || "*";
					node.__outputType = displayType;
					node.size = node.computeSize();
					node.applyOrientation();

					for (const l of node.outputs[slot].links || []) {
						const link = app.graph.links[l];
						if (link) {
							link.color = color;
						}
					}
				}

				if (inputNode) {
					const link = app.graph.links[inputNode.inputs[i].link];
					if (link) {
						link.color = color;
					}
				}

			}

			getExtraMenuOptions(_, options) {
				options.unshift(
					{
						content: "Add input",
						callback: () => {
							var len = this.inputs.length
							this.addInput("", "*");
							this.addOutput("", "*");
							this.inputs[len].dir = this.inputs[0].dir;
							this.outputs[len].dir = this.outputs[0].dir;
							this.size = this.computeSize();
							this.applyOrientation();
						}
					},
					{
						content: (this.properties.showOutputText ? "Hide" : "Show") + " Type",
						callback: () => {
							this.properties.showOutputText = !this.properties.showOutputText;
							this.size = this.computeSize();
							this.applyOrientation();
							app.graph.setDirtyCanvas(true, true);
						},
					},
					{
						content: (RerouteNode.defaultVisibility ? "Hide" : "Show") + " Type By Default",
						callback: () => {
							RerouteNode.setDefaultTextVisibility(!RerouteNode.defaultVisibility);
						},
					},
					{
						content: "Input Orientation",
						has_submenu: true,
						options: {isInput: true},
						callback: getOrientationMenu
					},
					{
						content: "Output Orientation",
						has_submenu: true,
						options: {isInput: false},
						callback: getOrientationMenu
					},
				);
			}

			applyOrientation() {
				// Place inputs/outputs based on the direction
				function processInOut(node, slot, index, slotcount) {
					if (!slot) { return; } // weird copy/paste fix

					const horizontal = ([LiteGraph.UP, LiteGraph.DOWN].indexOf(slot.dir) > -1);
					const reversed = ([LiteGraph.DOWN, LiteGraph.RIGHT].indexOf(slot.dir) > -1);
					const sections = slotcount+1;
					const mypos = index+1;
    

					if (horizontal) {
						slot.pos = [(node.size[0] / sections)*mypos, reversed ? node.size[1]:0];
					} else {
						slot.pos = [reversed ? node.size[0]:0, (node.size[1] / sections)*mypos];
					}
				}

				for (let i = 0; i < this.inputs.length; i++) {
					processInOut(this, this.inputs[i], i, this.inputs.length);
					processInOut(this, this.outputs[i], i, this.inputs.length);
				}

				app.graph.setDirtyCanvas(true, true);
			}

			getDisplayName() {
				let displayName = this.__outputType || "Reroute"
				if (this.title !== "Reroute" && this.title !== "") {
					displayName = this.title || "Reroute";
				}
				return displayName;
			}

			computeSize() {
				const output_horizontal = this.outputs && ([LiteGraph.LEFT, LiteGraph.RIGHT].indexOf(this.outputs[0].dir) > -1);
				const input_horizontal = this.inputs && ([LiteGraph.LEFT, LiteGraph.RIGHT].indexOf(this.inputs[0].dir) > -1);
				const outputs = this.inputs?.length || 1;
				const only_vertical = !output_horizontal && !input_horizontal;
				const only_horizontal = output_horizontal && input_horizontal;
				const vert_needed = only_vertical ? 35 : 25 + outputs * 15;
				const horiz_needed = only_horizontal ? 35 : 25 + 15 * outputs;
				
				return [
					this.properties.showOutputText && this.outputs
						? Math.max(horiz_needed, LiteGraph.NODE_TEXT_SIZE * this.getDisplayName().length * 0.6)
						: horiz_needed,
					vert_needed
				];
			}

			static setDefaultTextVisibility(visible) {
				RerouteNode.defaultVisibility = visible;
				if (visible) {
					localStorage["Comfy.RerouteNode.DefaultVisibility"] = "true";
				} else {
					delete localStorage["Comfy.RerouteNode.DefaultVisibility"];
				}
			}
		}

		// Load default visibility
		RerouteNode.setDefaultTextVisibility(!!localStorage["Comfy.RerouteNode.DefaultVisibility"]);

		LiteGraph.registerNodeType(
			"Reroute",
			Object.assign(RerouteNode, {
				title_mode: LiteGraph.NO_TITLE,
				title: "Reroute",
				collapsable: false,
			})
		);

		RerouteNode.category = "utils";
	},
	setup(app) {

		// adds "Add reroute" to right click canvas menu
		const orig = LGraphCanvas.prototype.getCanvasMenuOptions;
		LGraphCanvas.prototype.getCanvasMenuOptions = function () {
			const options = orig.apply(this, arguments);
			options.push(
				null,
				{ 
					content: "Add Reroute",
					callback: (value, options, mouse_event, menu, node) => {
						let newNode = LiteGraph.createNode("Reroute")

						newNode.pos = app.canvas.convertEventToCanvasOffset(mouse_event);
						newNode.pos[0] -= newNode.size[0]/2;
						newNode.pos[1] -= newNode.size[1]/2;

						app.graph.add(newNode);

					} 
				}
			);
			return options;
		};
	}
});
