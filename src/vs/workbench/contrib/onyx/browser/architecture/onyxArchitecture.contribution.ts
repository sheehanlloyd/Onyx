/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/onyxArchitecture.css';
import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { OnyxArchitectureViewPane } from './onyxArchitectureView.js';

/**
 * The Architecture view gets its own activity-bar container rather than a slot
 * in the control plane: the control plane is about what the agent is doing
 * right now, while the map is about understanding the codebase — a different
 * activity, deserving its own entry point and the sidebar's width.
 */
export const ONYX_ARCHITECTURE_CONTAINER_ID = 'workbench.panel.onyxArchitecture';

const architectureIcon = registerIcon('onyx-architecture-icon', Codicon.typeHierarchySub, localize('onyxArchitectureIcon', "Icon of the Onyx architecture map view."));

const container: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: ONYX_ARCHITECTURE_CONTAINER_ID,
	title: localize2('onyx.architecture.title', "Architecture"),
	icon: architectureIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ONYX_ARCHITECTURE_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: ONYX_ARCHITECTURE_CONTAINER_ID,
	hideIfEmpty: false,
	order: 6,
}, ViewContainerLocation.Sidebar, { doNotRegisterOpenCommand: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: OnyxArchitectureViewPane.ID,
		name: localize2('onyx.architecture.viewName', "Architecture Map"),
		containerIcon: architectureIcon,
		ctorDescriptor: new SyncDescriptor(OnyxArchitectureViewPane),
		canToggleVisibility: false,
		canMoveView: true,
		order: 1,
		weight: 100,
		openCommandActionDescriptor: {
			id: 'onyx.openArchitecture',
			title: localize2('onyx.openArchitecture', "Open Architecture Map"),
			order: 3,
		},
	},
], container);
