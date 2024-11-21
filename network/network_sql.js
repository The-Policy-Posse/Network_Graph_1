/**
 * Core Initialization and Global Variables
 */

// Select the main SVG element and get its dimensions
const svg = d3.select("svg");
const width = svg.node().clientWidth;
const height = svg.node().clientHeight;

// Global state variables
let fullData = null;          // Holds the complete dataset
let currentElements = null;    // Holds current D3 selections for nodes/links
let selectedNode = null;       // Currently selected node
let selectedState = null;      // Currently selected state
let currentView = 'main';      // Current view mode: 'main', 'state', or 'individual'

// Create tooltip div for hover information
const tooltip = d3.select("body").append("div")
    .attr("class", "tooltip")
    .style("opacity", 0);

/**
 * Utility Functions
 */

// Returns color based on party affiliation
function partyColor(party) {
    switch(party) {
        case 'D': return "#0366d6";    // Democrat - Blue
        case 'R': return "#d73a49";    // Republican - Red
        default: return "#6a737d";     // Independent/Other - Gray
    }
};

/**
 * Policy Filter Initialization
 * Sets up the Select2 dropdown for filtering by policy area
 */
function initializePolicyFilter(data) {
    // Map policies to dropdown options with counts
    const policyOptions = data.policies.map(p => ({
        id: p.id,
        text: `${p.name} (${data.metadata.policies.counts[p.name] || 0})`
    }));

    // Initialize Select2 dropdown with policy options
    $('#policy-filter').select2({
        placeholder: 'Search for a subject area...',
        allowClear: true,
        data: [
            { id: 'all', text: 'All Subject Areas' },
            ...policyOptions
        ]
    }).on('change', function() {
        const selectedPolicy = this.value;
        if (fullData) {
            // Redraw network with new policy filter
            currentElements = drawNetwork(
                fullData,
                +d3.select("#connection-threshold").property("value"),
                selectedPolicy
            );
        }
    });
}

/**
 * Metadata Update Function
 * Updates the network information panel with current data
 */
function updateMetadata(data) {
    const metadata = d3.select("#metadata");
    const congressRange = data.metadata.congress_range;
    
    // Format congress range display
    const congressDisplay = congressRange.start === congressRange.end 
        ? `${congressRange.start}th`
        : `${congressRange.start}th-${congressRange.end}th`;
    
    // Count unique bills
    const uniqueBills = new Set(data.bills.map(b => b.bill_number)).size;

    // Format dates helper function
    const formatDate = (dateStr) => {
        const date = new Date(dateStr);
        return new Intl.DateTimeFormat('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
        }).format(date);
    };

    // Format date range
    const startDate = formatDate(data.metadata.date_range.start);
    const endDate = formatDate(data.metadata.date_range.end);
    
    // Update metadata display
    metadata.html(`
        <p>
            Congress: ${congressDisplay}<br>
            Dates: ${startDate} to ${endDate}<br>
            Total Bills: ${uniqueBills}<br>
            Total Policies: ${data.policies.length}
        </p>
    `);
}

/**
 * Network Configuration Constants
 */
const MAX_CONNECTIONS = 4000;  // Maximum number of connections to display
const SAMPLING_METHODS = {
    RANDOM: 'random',          // Random sampling of connections
    WEIGHTED: 'weighted'       // Preserves stronger collaborations
};
const SAMPLING_METHOD = SAMPLING_METHODS.RANDOM;

/**
 * Network Data Filtering
 * Processes raw data to create a filtered, displayable network based on:
 * - Minimum connection threshold
 * - Selected policy area
 * - Performance limitations
 * 
 * @param {Object} data - The complete network dataset
 * @param {number} minConnections - Minimum number of collaborations required (default: 10)
 * @param {string} policyId - Selected policy area ID ('all' or specific ID)
 * @returns {Object} Filtered network data with nodes, links, and count information
 */
function filterNetwork(data, minConnections = 10, policyId = "all") {
    // Filter bills by policy if a specific policy is selected
    let filteredBills = data.bills;
    if (policyId !== "all") {
        filteredBills = data.bills.filter(b => 
            String(b.policy_id) === String(policyId)
        );
    }

    // Create set of valid bill numbers and filter collaborations
    const validBills = new Set(filteredBills.map(b => b.bill_number));
    let filteredCollaborations = data.collaborations.filter(c => 
        validBills.has(c.bill_number)
    );

    // Calculate collaboration counts between legislator pairs
    const collaborationCounts = {};
    filteredCollaborations.forEach(collab => {
        // Create unique key for each legislator pair (sorted to ensure consistency)
        const key = [collab.source, collab.target].sort().join('-');
        collaborationCounts[key] = (collaborationCounts[key] || 0) + 1;
    });

    // Filter collaborations by minimum connection threshold
    filteredCollaborations = filteredCollaborations.filter(collab => {
        const key = [collab.source, collab.target].sort().join('-');
        return collaborationCounts[key] >= minConnections;
    });

    // Performance optimization - sample connections if exceeding maximum
    let prefilterCollaborations_length = filteredCollaborations.length;
    if (filteredCollaborations.length > MAX_CONNECTIONS) {
        filteredCollaborations = sampleConnections(
            filteredCollaborations, 
            collaborationCounts
        );
    }

    // Get active legislators (those with remaining connections)
    const activeIds = new Set();
    filteredCollaborations.forEach(collab => {
        activeIds.add(collab.source);
        activeIds.add(collab.target);
    });

    // Filter legislator nodes to only include active ones
    const uniqueLegislators = [...new Set(data.legislators.map(d => d.id))];
    const activeNodes = data.legislators.filter(d => 
        activeIds.has(d.id) && 
        // Ensure no duplicate legislators
        uniqueLegislators.indexOf(d.id) === uniqueLegislators.lastIndexOf(d.id)
    );

    // Return filtered network data with statistics
    return {
        nodes: activeNodes,
        links: filteredCollaborations,
        counts: {
            legislators: activeNodes.length,
            connections: prefilterCollaborations_length,
            bills: validBills.size,
            sampled: filteredCollaborations.length > MAX_CONNECTIONS
        }
    };
}

/**
 * Connection Sampling
 * Reduces the number of connections to improve performance while maintaining
 * visual meaning through either random or weighted sampling.
 * 
 * @param {Array} collaborations - Array of collaboration links
 * @param {Object} collaborationCounts - Count of collaborations between each pair
 * @returns {Array} Sampled subset of collaborations
 */
function sampleConnections(collaborations, collaborationCounts) {
    if (SAMPLING_METHOD === SAMPLING_METHODS.RANDOM) {
        // Simple random sampling
        return shuffleArray(collaborations).slice(0, MAX_CONNECTIONS);
    } else {
        // Weighted sampling - preserves stronger collaborations
        const weightedCollaborations = collaborations.map(collab => ({
            ...collab,
            // Add weight based on number of collaborations between the pair
            weight: collaborationCounts[
                [collab.source, collab.target].sort().join('-')
            ]
        }));

        // Sort by weight and take top connections
        return weightedCollaborations
            .sort((a, b) => b.weight - a.weight)
            .slice(0, MAX_CONNECTIONS);
    }
}

/**
 * Array Shuffling (Fisher-Yates algorithm)
 * Used for random sampling of connections
 * 
 * @param {Array} array - Array to shuffle
 * @returns {Array} New shuffled array
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Node Highlighting and Selection
 * Manages the visual highlighting of nodes and their connections
 * 
 * @param {Object} node - The node being highlighted
 * @param {Object} elements - Current D3 selections for nodes and links
 */
function highlightConnections(node, elements) {
    // Toggle highlight if node is already selected
    if (selectedNode === node) {
        clearHighlighting(elements);
        return;
    }

    selectedNode = node;

    // Find connected nodes and links
    const connectedLinks = elements.links.filter(l => 
        l.source === node.id || l.target === node.id
    );

    const connectedNodes = new Set();
    connectedLinks.each(l => {
        connectedNodes.add(l.source);
        connectedNodes.add(l.target);
    });

    // Apply visual highlighting
    elements.nodes
        .classed("selected-node", d => d.id === node.id)
        .classed("dimmed", d => !connectedNodes.has(d.id) && d.id !== node.id);

    // Update link colors based on connected parties
    elements.links
        .style("stroke", l => {
            if (l.source === node.id) {
                const targetNode = elements.nodes
                    .filter(d => d.id === l.target)
                    .datum();
                return targetNode ? partyColor(targetNode.party) : "#999";
            } else if (l.target === node.id) {
                const sourceNode = elements.nodes
                    .filter(d => d.id === l.source)
                    .datum();
                return sourceNode ? partyColor(sourceNode.party) : "#999";
            }
            return "#999";
        })
        .style("stroke-opacity", l => 
            l.source === node.id || l.target === node.id ? 0.1 : 0
        );

    // Update node information panel
    updateNodeInfo(node, elements.links.data(), fullData);
}

/**
 * Clear Network Highlighting
 * Resets all visual highlights and returns network to default state
 * 
 * @param {Object} elements - Current D3 selections for nodes and links
 */
function clearHighlighting(elements) {
    selectedNode = null;  // Clear selected node state

    // Reset node styling
    elements.nodes
        .classed("selected-node", false)  // Remove selection highlight
        .classed("dimmed", false);        // Remove dimming

    // Reset link styling
    elements.links
        .style("stroke", "#999")          // Reset to default color
        .style("stroke-opacity", 0.1);    // Reset to default opacity
}

/**
 * Calculate State-based Node Positions
 * Organizes nodes in a circular layout grouped by state
 * 
 * @param {Array} nodes - Array of node objects
 * @param {number} radius - Radius of the circular layout
 * @returns {Object} State groups and ordered state names
 */
function calculateStatePositions(nodes, radius) {
    // Group nodes by state
    const stateGroups = {};
    nodes.forEach(node => {
        if (!stateGroups[node.state]) {
            stateGroups[node.state] = [];
        }
        stateGroups[node.state].push(node);
    });

    // Sort states alphabetically for consistent layout
    const states = Object.keys(stateGroups).sort();
    const totalStates = states.length;
    
    // Calculate angular spacing
    const stateGap = 0.02;                    // Gap between state groups
    const totalGaps = totalStates * stateGap;
    const availableAngle = 2 * Math.PI - totalGaps;  // Total angle minus gaps
    const stateAngleStep = availableAngle / totalStates;

    // Position nodes within their state groups
    states.forEach((state, stateIndex) => {
        const stateNodes = stateGroups[state];
        const nodesInState = stateNodes.length;
        
        // Calculate starting angle for this state group
        const stateStartAngle = (stateIndex * (stateAngleStep + stateGap)) - Math.PI / 2;
        
        // Distribute nodes within the state's arc
        const nodeAngleStep = stateAngleStep / Math.max(1, nodesInState);
        
        stateNodes.forEach((node, nodeIndex) => {
            const angle = stateStartAngle + (nodeIndex * nodeAngleStep);
            // Calculate x,y positions using polar coordinates
            node.x = radius * Math.cos(angle);
            node.y = radius * Math.sin(angle);
            // Store state angle for label positioning
            node.stateAngle = stateStartAngle + (stateAngleStep / 2);
        });
    });

    return { stateGroups, states };
}

/**
 * State View Transition
 * Handles the transition animation when focusing on a specific state
 * 
 * @param {string} state - State abbreviation to focus on
 * @param {Object} nodes - D3 selection of nodes
 * @param {Object} links - D3 selection of links
 * @param {Object} filtered - Filtered network data
 * @param {number} radius - Base radius for layout
 */
function transitionToStateView(state, nodes, links, filtered, radius) {
    const t = d3.transition().duration(750);  // 750ms transition
    const innerRadius = radius * 0.5;         // Radius for focused state

    // Find nodes in selected state
    const stateNodes = filtered.nodes.filter(n => n.state === state);
    const angleStep = (2 * Math.PI) / stateNodes.length;

    // Find connected nodes and links
    const connectedNodeIds = new Set();
    const connectedLinkIds = new Set();
    
    // Add selected state nodes
    stateNodes.forEach(n => connectedNodeIds.add(n.id));
    
    // Find all connections to/from selected state nodes
    filtered.links.forEach(link => {
        const sourceNode = filtered.nodes.find(n => n.id === link.source);
        const targetNode = filtered.nodes.find(n => n.id === link.target);
        
        if (sourceNode?.state === state || targetNode?.state === state) {
            connectedLinkIds.add(link.source + '-' + link.target);
            connectedNodeIds.add(link.source);
            connectedNodeIds.add(link.target);
        }
    });

    // Update node positions with transition
    nodes.transition(t)
        .attr("transform", d => {
            if (d.state === state) {
                // Position state nodes in inner circle
                const idx = stateNodes.indexOf(d);
                const angle = idx * angleStep - Math.PI / 2;
                const newX = innerRadius * Math.cos(angle);
                const newY = innerRadius * Math.sin(angle);
                return `translate(${newX},${newY})`;
            }
            // Keep other nodes in outer circle
            return `translate(${d.x},${d.y})`;
        })
        .style("opacity", d => connectedNodeIds.has(d.id) ? 1 : 0.1);

    // Update link positions and visibility
    links.transition(t)
        .style("opacity", d => {
            const linkId = d.source + '-' + d.target;
            return connectedLinkIds.has(linkId) ? 0.6 : 0.05;
        })
        .attr("d", d => {
            // Complex path calculation for links...
            // [Previous link path calculation code remains the same]
        });
}

/**
 * Draw Network Visualization
 * Main function for creating and updating the network visualization
 * 
 * @param {Object} data - Complete network dataset
 * @param {number} minConnections - Minimum connections threshold (default: 10)
 * @param {string} policyId - Selected policy area ID (default: 'all')
 * @returns {Object} Current D3 selections for nodes and links
 */
function drawNetwork(data, minConnections = 10, policyId = "all") {
    // Clear existing visualization
    svg.selectAll("*").remove();
    
    // Filter and process network data
    const filtered = filterNetwork(data, minConnections, policyId);
    let selectedState = null;
    let selectedNode = null;
    let currentView = 'main';
    
    // Update statistics display
    d3.select("#active-legislators").text(filtered.counts.legislators);
    d3.select("#active-connections")
        .html(`${filtered.counts.connections}${filtered.counts.sampled ? '*' : ''}`);
    
    // Add sampling indicator if network was sampled
    if (filtered.counts.sampled) {
        d3.select(".legend")
            .append("div")
            .attr("class", "sampling-note")
            .style("font-size", "0.8rem")
            .style("color", "#586069")
            .style("margin-top", "0.5rem")
            .text(`* Showing ${MAX_CONNECTIONS} representative connections out of ${filtered.counts.connections} total`);
    } else {
        d3.select(".sampling-note").remove();
    }

    // Create main SVG group and center it
    const g = svg.append("g")
        .attr("transform", `translate(${width/2},${height/2})`);

    // Calculate layout dimensions
    const radius = Math.min(width, height) / 2.5;  // Base radius for layout
    const labelRadius = radius + 60;               // Radius for state labels

    // Calculate node positions based on states
    const { states } = calculateStatePositions(filtered.nodes, radius);

    /**
     * Create Network Links
     * Draw curved lines representing legislator collaborations
     */
    const links = g.append("g")
        .selectAll("path")
        .data(filtered.links)
        .join("path")
        .style("stroke", "#999")                    // Default link color
        .style("stroke-opacity", 0.05)             // Default link opacity
        .style("fill", "none")                     // Links are lines, not filled paths
        .style("stroke-width", d => 1 + Math.sqrt(d.value || 1))  // Link weight
        .attr("d", createLinkPath);                // Create curved path

    /**
     * Create State Labels
     * Add interactive labels for each state
     */
    const stateLabels = g.append("g")
        .attr("class", "state-labels")
        .selectAll("text")
        .data(states)
        .join("text")
        .attr("class", d => `state-label state-label-${d}`)
        .text(d => d)
        // Position labels in a circle around the network
        .attr("x", (d, i) => {
            const angle = (i * (2 * Math.PI / states.length)) - Math.PI / 2;
            return labelRadius * Math.cos(angle);
        })
        .attr("y", (d, i) => {
            const angle = (i * (2 * Math.PI / states.length)) - Math.PI / 2;
            return labelRadius * Math.sin(angle);
        })
        .attr("text-anchor", "middle")
        .attr("alignment-baseline", "middle")
        .style("font-size", "12px")
        .style("font-weight", "bold")
        .style("cursor", "pointer")
        .attr("position", "fixed")
        // Add click handler for state focus
        .on("click", (event, d) => {
            event.stopPropagation();
            if (currentView === 'main') {
                transitionToStateView(d);
            } else if (currentView === 'state' && selectedState !== d) {
                transitionToStateView(d);
            }
        });

    /**
     * Create Network Nodes
     * Draw circles representing legislators
     */
    const nodes = g.append("g")
        .selectAll("circle")
        .data(filtered.nodes)
        .join("circle")
        // Node size based on collaboration count
        .attr("r", d => 5 + .5*(d.metrics?.total_collaborations || 0)**(1/2))
        // Position nodes according to state-based layout
        .attr("transform", d => `translate(${d.x},${d.y})`)
        .style("fill", d => partyColor(d.party))    // Color by party
        .style("stroke", "#fff")                    // White border
        .style("stroke-width", 1.5)
        .style("cursor", "pointer");                // Show pointer cursor

    /**
     * Helper Functions for Path Generation
     */
    function createLinkPath(d) {
        const source = getNodePosition(d.source);
        const target = getNodePosition(d.target);
        if (!source || !target) return null;
        
        // Calculate curved path
        const dx = target.x - source.x,
            dy = target.y - source.y,
            dr = Math.sqrt(dx * dx + dy * dy) * 2;  // Curve radius
        
        return `M${source.x},${source.y}A${dr},${dr} 0 0,1 ${target.x},${target.y}`;
    }

    function getNodePosition(nodeId) {
        const node = filtered.nodes.find(n => n.id === nodeId);
        if (!node) return null;

        // Handle different view states
        if (currentView === 'individual' && selectedNode && node.id === selectedNode.id) {
            return { x: 0, y: 0 };  // Center selected node
        } else if ((currentView === 'state' || currentView === 'individual') && 
                node.state === selectedState) {
            // Position nodes in focused state
            const stateNodes = filtered.nodes.filter(n => n.state === selectedState);
            const idx = stateNodes.indexOf(node);
            const angleStep = (2 * Math.PI) / stateNodes.length;
            const angle = idx * angleStep - Math.PI / 2;
            const innerRadius = radius * 0.5;
            return {
                x: innerRadius * Math.cos(angle),
                y: innerRadius * Math.sin(angle)
            };
        }
        return { x: node.x, y: node.y };  // Default position
    }

    /**
     * Calculate Ring Layout Positions
     * Determines positions for states in the outer ring when a state is focused
     * 
     * @param {Array} nodes - Array of all nodes
     * @param {string} excludeState - State to exclude from ring (focused state)
     * @returns {Object} Mapping of states to their angular positions
     */
    function calculateRingPositions(nodes, excludeState = null) {
        // Get unique states excluding the focused state
        const activeStates = [...new Set(nodes.map(n => n.state))]
            .filter(s => s !== excludeState)
            .sort();
        
        // Calculate even spacing around the circle
        const angleStep = (2 * Math.PI) / activeStates.length;
        
        // Create mapping of states to their angular positions
        const statePositions = {};
        activeStates.forEach((state, i) => {
            const angle = i * angleStep - Math.PI / 2;  // Start at top (-π/2)
            statePositions[state] = angle;
        });
        
        return statePositions;
    }

    /**
     * Create State Label
     * Creates a group containing the state label with proper positioning
     */
    function createStateLabel(state, x, y) {
        const label = g.append("g")
            .attr("class", `state-label-group-${state}`)
            .attr("transform", `translate(${x},${y})`);
            
        label.append("text")
            .text(state)
            .attr("text-anchor", "middle")
            .attr("alignment-baseline", "middle")
            .style("font-size", "12px")
            .style("font-weight", "bold");
            
        return label;
    }

    /**
     * Highlight Node Connections
     * Emphasizes a selected node and its connections
     * 
     * @param {Object} node - Selected node data
     */
    function highlightConnections(node) {
        // Track connected nodes and links
        const connectedNodes = new Set([node.id]);
        const connectedLinks = new Set();

        // Find all connections for the selected node
        filtered.links.forEach(link => {
            if (link.source === node.id) {
                connectedNodes.add(link.target);
                connectedLinks.add(`${link.source}-${link.target}`);
            }
            if (link.target === node.id) {
                connectedNodes.add(link.source);
                connectedLinks.add(`${link.source}-${link.target}`);
            }
        });

        // Update node visibility
        nodes.style("opacity", d => connectedNodes.has(d.id) ? 1 : 0.1);

        // Update link colors and visibility
        links
            .style("stroke", link => {
                const linkId = `${link.source}-${link.target}`;
                if (connectedLinks.has(linkId)) {
                    if (link.source === node.id) {
                        const targetNode = filtered.nodes.find(n => n.id === link.target);
                        return partyColor(targetNode.party);
                    }
                    if (link.target === node.id) {
                        const sourceNode = filtered.nodes.find(n => n.id === link.source);
                        return partyColor(sourceNode.party);
                    }
                }
                return "#999";
            })
            .style("stroke-opacity", link => {
                const linkId = `${link.source}-${link.target}`;
                return connectedLinks.has(linkId) ? 0.1 : 0.00;
            });

        // Update node info panel
        updateNodeInfo(node, filtered.links, fullData);
    }

    /**
     * Highlight State Connections
     * Emphasizes all nodes and connections related to a selected state
     * 
     * @param {string} state - Selected state abbreviation
     */
    function highlightStateConnections(state) {
        const connectedNodes = new Set();
        const connectedLinks = new Set();

        // Add all nodes from the selected state
        filtered.nodes.filter(n => n.state === state)
            .forEach(node => connectedNodes.add(node.id));

        // Find all connections to/from the state's nodes
        filtered.links.forEach(link => {
            const sourceNode = filtered.nodes.find(n => n.id === link.source);
            const targetNode = filtered.nodes.find(n => n.id === link.target);
            
            if (sourceNode?.state === state || targetNode?.state === state) {
                connectedNodes.add(link.source);
                connectedNodes.add(link.target);
                connectedLinks.add(`${link.source}-${link.target}`);
            }
        });

        // Update node visibility
        nodes.style("opacity", d => connectedNodes.has(d.id) ? 1 : 0.1);
        
        // Update link visibility
        links
            .style("stroke", "#999")  // Keep links neutral in state view
            .style("stroke-opacity", link => {
                const linkId = `${link.source}-${link.target}`;
                return connectedLinks.has(linkId) ? 0.05 : 0.00;
            });
    }

    /**
     * Transition to State View
     * Animates the network to focus on a specific state
     * 
     * @param {string} state - State abbreviation to focus on
     */
    function transitionToStateView(state) {
        selectedState = state;
        currentView = 'state';
        const t = d3.transition().duration(750);  // 750ms animation
        const innerRadius = radius * 0.5;         // Radius for focused state
        
        // Calculate new positions for states in the outer ring
        const statePositions = calculateRingPositions(filtered.nodes, state);

        // Move selected state label to center-top position
        d3.select(`.state-label-group-${state}`)
            .transition(t)
            .attr("transform", `translate(0,0)`)
            .style("font-size", "16px");  // Enlarge focused state label
            
        // Reposition other state labels
        Object.entries(statePositions).forEach(([s, angle]) => {
            d3.select(`.state-label-group-${s}`)
                .transition(t)
                .attr("transform", `translate(
                    ${labelRadius * Math.cos(angle)},
                    ${labelRadius * Math.sin(angle)}
                )`);
        });
        
        // Update state label positions and styling
        stateLabels.transition(t)
            .attr("x", d => {
                if (d === state) {
                    return 0; // Center
                } else {
                    const angle = statePositions[d];
                    return labelRadius * Math.cos(angle);
                }
            })
            .attr("y", d => {
                if (d === state) {
                    return -labelRadius/2 - 20; // Slightly above center
                } else {
                    const angle = statePositions[d];
                    return labelRadius * Math.sin(angle);
                }
            })
            .style("font-size", d => d === state ? "18px" : "12px")
            .style("opacity", d => d === state ? 1 : 0.9);
        
        // Transition nodes to new positions
        nodes.transition(t)
            .attr("transform", d => {
                if (d.state === state) {
                    // Position state nodes in inner circle
                    const stateNodes = filtered.nodes.filter(n => n.state === state);
                    const idx = stateNodes.indexOf(d);
                    const angleStep = (2 * Math.PI) / stateNodes.length;
                    const angle = idx * angleStep - Math.PI / 2;
                    return `translate(${innerRadius * Math.cos(angle)},${innerRadius * Math.sin(angle)})`;
                } else {
                    // Position other nodes in outer ring
                    const angle = statePositions[d.state];
                    return `translate(${radius * Math.cos(angle)},${radius * Math.sin(angle)})`;
                }
            });

        // Update link paths with optimized rendering
        links.transition(t)
            .attr("d", d => {
                const source = filtered.nodes.find(n => n.id === d.source);
                const target = filtered.nodes.find(n => n.id === d.target);
                
                if (!source || !target) return null;
                
                let sourceX, sourceY, targetX, targetY;
                const sourceInState = source.state === state;
                const targetInState = target.state === state;
                
                // Calculate positions based on state membership
                if (sourceInState) {
                    const stateNodes = filtered.nodes.filter(n => n.state === state);
                    const idx = stateNodes.indexOf(source);
                    const angleStep = (2 * Math.PI) / stateNodes.length;
                    const angle = idx * angleStep - Math.PI / 2;
                    sourceX = innerRadius * Math.cos(angle);
                    sourceY = innerRadius * Math.sin(angle);
                } else {
                    const angle = statePositions[source.state];
                    sourceX = radius * Math.cos(angle);
                    sourceY = radius * Math.sin(angle);
                }
                
                if (targetInState) {
                    const stateNodes = filtered.nodes.filter(n => n.state === state);
                    const idx = stateNodes.indexOf(target);
                    const angleStep = (2 * Math.PI) / stateNodes.length;
                    const angle = idx * angleStep - Math.PI / 2;
                    targetX = innerRadius * Math.cos(angle);
                    targetY = innerRadius * Math.sin(angle);
                } else {
                    const angle = statePositions[target.state];
                    targetX = radius * Math.cos(angle);
                    targetY = radius * Math.sin(angle);
                }
                
                // Optimize curve based on node positions
                if (sourceInState && targetInState) {
                    // Both nodes in inner circle - tighter curve
                    const dr = Math.sqrt((targetX - sourceX)**2 + (targetY - sourceY)**2) * 1.5;
                    return `M${sourceX},${sourceY}A${dr},${dr} 0 0,1 ${targetX},${targetY}`;
                } else {
                    // At least one node on outer ring - wider curve
                    const dr = Math.sqrt((targetX - sourceX)**2 + (targetY - sourceY)**2) * 2;
                    return `M${sourceX},${sourceY}A${dr},${dr} 0 0,1 ${targetX},${targetY}`;
                }
            });

        // Apply state-level highlighting
        highlightStateConnections(state);
    }

    /**
     * Transition to Individual Node View
     * Animates the network to focus on a specific legislator
     * 
     * @param {Object} node - Node data for the selected legislator
     */
    function transitionToIndividualView(node) {
        selectedNode = node;
        currentView = 'individual';
        const t = d3.transition().duration(750);

        // Transition nodes to new positions
        nodes.transition(t)
            .attr("transform", d => {
                const pos = getNodePosition(d.id);
                return `translate(${pos.x},${pos.y})`;
            });

        // Update link paths
        links.transition(t)
            .attr("d", createLinkPath);

        // Apply node-level highlighting
        highlightConnections(node);
    }

    /**
     * Reset to Main View
     * Returns the network to its initial state
     */
    function resetToMainView() {
        selectedState = null;
        selectedNode = null;
        currentView = 'main';
        const t = d3.transition().duration(750);
        
        // Reset state labels to original positions
        states.forEach((state, i) => {
            const angle = (i * (2 * Math.PI / states.length)) - Math.PI / 2;
            d3.select(`.state-label-group-${state}`)
                .transition(t)
                .attr("transform", `translate(
                    ${labelRadius * Math.cos(angle)},
                    ${labelRadius * Math.sin(angle)}
                )`)
                .style("font-size", "12px");
        });
        
        // Reset label positions and styling
        stateLabels.transition(t)
            .attr("x", (d, i) => {
                const angle = (i * (2 * Math.PI / states.length)) - Math.PI / 2;
                return labelRadius * Math.cos(angle);
            })
            .attr("y", (d, i) => {
                const angle = (i * (2 * Math.PI / states.length)) - Math.PI / 2;
                return labelRadius * Math.sin(angle);
            })
            .style("font-size", "12px")
            .style("opacity", 1);

        // Reset nodes and links
        nodes.transition(t)
            .attr("transform", d => `translate(${d.x},${d.y})`)
            .style("opacity", 1);

        links.transition(t)
            .attr("d", createLinkPath)
            .style("stroke", "#999")
            .style("stroke-opacity", 0.05);
    }

    /**
     * Reset to State View
     * Returns the network to state focus view from individual node focus
     */
    function resetToStateView() {
        selectedNode = null;
        currentView = 'state';
        const t = d3.transition().duration(750);

        // Reset link styling
        links.transition(t)
            .style("stroke", "#999")
            .style("stroke-opacity", 0.0)
            .attr("d", createLinkPath);

        // Reset node positions
        nodes.transition(t)
            .attr("transform", d => {
                const pos = getNodePosition(d.id);
                return `translate(${pos.x},${pos.y})`;
            });

        // Reapply state highlighting after transition
        t.end().then(() => {
            highlightStateConnections(selectedState);
        });
    }

    /**
     * Update Node Information Panel
     * Updates the sidebar panel with detailed information about a selected legislator
     * 
     * @param {Object} node - The selected legislator node
     * @param {Array} links - Array of all network links
     * @param {Object} data - Complete network dataset
     */
    function updateNodeInfo(node, links, data) {
        // Get all links connected to this node
        const nodeLinks = links.filter(l => 
            l.source === node.id || l.target === node.id
        );
        
        // Get unique bills for this legislator's connections
        const nodeBills = new Set(nodeLinks.map(l => l.bill_number));
        const relevantBills = data.bills.filter(b => nodeBills.has(b.bill_number));

        // Create mapping of bills to their policy areas
        const billPolicyMap = {};
        relevantBills.forEach(bill => {
            if (!billPolicyMap[bill.bill_number]) {
                billPolicyMap[bill.bill_number] = [];
            }
            // Add unique policy names for each bill
            if (!billPolicyMap[bill.bill_number].includes(bill.policy_name)) {
                billPolicyMap[bill.bill_number].push(bill.policy_name);
            }
        });

        // Count frequency of each policy area
        const policyCount = {};
        relevantBills.forEach(bill => {
            policyCount[bill.policy_name] = (policyCount[bill.policy_name] || 0) + 1;
        });

        // Get unique bills (prevent duplicates)
        const displayedBillIds = new Set();
        const uniqueBills = relevantBills.filter(bill => {
            if (!displayedBillIds.has(bill.bill_number)) {
                displayedBillIds.add(bill.bill_number);
                return true;
            }
            return false;
        });

        // Select and update the node info panel
        const nodeInfo = d3.select(".node-info");
        nodeInfo.html(`
            <!-- Legislator Header Information -->
            <h3>${node.name}</h3>
            <p>
                Party: ${node.party}<br>
                State: ${node.state}${node.district ? `-${node.district}` : ''}<br>
                Total Collaborations: ${node.metrics?.total_collaborations || 0}<br>
                Connected Legislators: ${
                    // Count unique connected legislators (excluding self)
                    new Set([
                        ...nodeLinks.map(l => l.source),
                        ...nodeLinks.map(l => l.target)
                    ]).size - 1
                }
            </p>

            <!-- Top Policy Areas Section -->
            <div>
                <h4>Top Policy Areas</h4>
                ${Object.entries(policyCount)
                    // Sort policies by frequency (descending)
                    .sort((a, b) => b[1] - a[1])
                    // Take top 3 policies
                    .slice(0, 3)
                    .map(([policy, count]) => `
                        <div class="policy-tag">
                            ${policy} (${count})
                        </div>
                    `).join('')}
            </div>

            <!-- Recent Bills Section -->
            <div class="bill-list">
                <h4>Recent Collaborative Bills</h4>
                ${uniqueBills
                    // Show up to 25 most recent bills
                    .slice(0, 25)
                    .map(bill => {
                        // Get up to 3 policy tags for each bill
                        const policyTags = billPolicyMap[bill.bill_number]
                            .slice(0, 3)
                            .join(', ');
                        
                        // Truncate long titles
                        const titleDisplay = bill.title.length < 100 
                            ? bill.title 
                            : bill.title.substring(0, 120) + '...';

                        return `
                            <div class="bill-item">
                                <strong>No.${bill.bill_number}</strong>
                                <div>${titleDisplay}</div>
                                <div class="bill-policy">${policyTags}</div>
                                <div style="font-size: 0.8rem; color: #586069; margin-top: 0.3rem;">
                                    Last Action: ${bill.latest_action_date}
                                </div>
                            </div>
                        `;
                    }).join('')}
            </div>
        `);
    }

    /**
     * Node Interaction Setup
     * Configure mouse events for network nodes
     */
    nodes
        // Hover events
        .on("mouseover", (event, d) => {
            tooltip.transition()
                .duration(200)
                .style("opacity", .9);
            tooltip.html(`
                ${d.name} (${d.party}-${d.state})<br/>
                District: ${d.district || 'At-large'}<br/>
                Collaborations: ${d.metrics?.total_collaborations || 0}
            `)
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 28) + "px");
        })
        .on("mouseout", () => {
            tooltip.transition()
                .duration(500)
                .style("opacity", 0);
        })
        // Click handling for view transitions
        .on("click", (event, d) => {
            event.stopPropagation();

            if (currentView === 'main') {
                // From main view, transition to state view
                transitionToStateView(d.state);
            } else if (currentView === 'state') {
                if (d.state === selectedState) {
                    // If clicking node in focused state, show individual view
                    transitionToIndividualView(d);
                } else {
                    // If clicking node in different state, switch state focus
                    transitionToStateView(d.state);
                }
            } else if (currentView === 'individual') {
                if (d.id === selectedNode.id) {
                    // If clicking selected node, return to state view
                    resetToStateView();
                } else if (d.state === selectedState) {
                    // If clicking different node in same state, switch focus
                    transitionToIndividualView(d);
                } else {
                    // If clicking node in different state, switch state focus
                    transitionToStateView(d.state);
                }
            }
        });

    /**
     * Background Click Handler
     * Handles clicks on the SVG background for view navigation
     */
    svg.on("click", (event) => {
        if (event.target.tagName === "svg") {
            if (currentView === 'individual') {
                // From individual view, return to state view
                resetToStateView();
            } else if (currentView === 'state') {
                // From state view, return to main view
                resetToMainView();
            }
        }
    });

    // Return current network elements for external reference
    return { nodes, links };
}

/**
 * Performance Monitoring
 * Tracks render time to detect performance issues
 */
let lastRenderTime = 0;
function monitorPerformance() {
    const currentTime = performance.now();
    const renderTime = currentTime - lastRenderTime;
    lastRenderTime = currentTime;
    
    if (renderTime > 3000) { // Warning threshold: 3 seconds
        console.warn(`Slow render detected: ${renderTime.toFixed(0)}ms`);
        // Could implement automatic performance optimization here
        // Example: MAX_CONNECTIONS = Math.floor(MAX_CONNECTIONS * 0.8);
    }
}

/**
 * Visualization Initialization
 * Main entry point for setting up the network visualization
 */
async function initializeVisualization() {
    try {
        console.log('Initializing visualization...');
        
        // Fetch network data from API
        console.log('Fetching data from API...');
        const response = await fetch('/api/network-data');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('Data received from API');

        // Validate data structure
        if (!data || !data.legislators || !data.bills || !data.collaborations) {
            throw new Error('Invalid data structure received from API');
        }
        
        // Store data globally for reference
        fullData = data;
        console.log('Data loaded:', {
            legislators: data.legislators.length,
            bills: data.bills.length,
            collaborations: data.collaborations.length,
            policies: data.policies.length
        });
        
        // Initialize UI components
        console.log('Initializing components...');
        initializePolicyFilter(data);
        updateMetadata(data);
        
        // Draw initial network
        console.log('Drawing network...');
        currentElements = drawNetwork(data);
        if (!currentElements) {
            throw new Error("Failed to create network elements");
        }
        console.log('Network drawn successfully');
        
        // Setup connection threshold slider
        const thresholdSlider = d3.select("#connection-threshold");
        const thresholdValue = d3.select(".filter-value");
        
        thresholdSlider.on("input", function() {
            const value = +this.value;
            thresholdValue.text(`${value} collaborations`);
            selectedNode = null;
            const start = performance.now();
            currentElements = drawNetwork(
                data,
                value,
                $('#policy-filter').val()
            );
            monitorPerformance();
        });
                        
        // Setup legislator search functionality
        d3.select("#legislator-search").on("input", function() {
            const searchTerm = this.value.toLowerCase();
            if (!currentElements) return;
            
            currentElements.nodes
                .style("opacity", d => 
                    d.name.toLowerCase().includes(searchTerm) ? 1 : 0.2
                );
            currentElements.links
                .style("opacity", 0.05);
        });
        
    } catch (error) {
        // Handle initialization errors
        console.error("Error loading or processing data:", error);
        d3.select(".main-content")
            .append("div")
            .attr("class", "error")
            .html(`
                <h3>Error Loading Network Data</h3>
                <p>${error.message}</p>
                <p>Please check that the API server is running.</p>
                <pre>${error.stack}</pre>
            `);
    }
}

// Initialize visualization when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, starting initialization...');
    initializeVisualization();
});