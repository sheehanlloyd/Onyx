/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../media/onyxControlPlane.css';
import '../onyxColors.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { OnyxActivityViewPane } from './onyxActivityView.js';
import { OnyxComputeViewPane } from './onyxComputeView.js';
import { OnyxContextBudgetViewPane } from './onyxContextBudgetView.js';
import { OnyxInspectorViewPane } from './onyxInspectorView.js';

export const ONYX_CONTROL_PLANE_CONTAINER_ID = 'workbench.panel.onyxControlPlane';

const onyxViewIcon = registerIcon('onyx-control-plane-icon', Codicon.pulse, localize('onyxViewIcon', "Icon of the Onyx control plane view."));

const container: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: ONYX_CONTROL_PLANE_CONTAINER_ID,
	title: localize2('onyx.controlPlane.title', "Onyx Control Plane"),
	icon: onyxViewIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ONYX_CONTROL_PLANE_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: false }]),
	storageId: ONYX_CONTROL_PLANE_CONTAINER_ID,
	hideIfEmpty: false,
	order: 2,
}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: false });

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([
	{
		id: OnyxActivityViewPane.ID,
		name: localize2('onyx.activity.name', "Agent Activity"),
		containerIcon: onyxViewIcon,
		ctorDescriptor: new SyncDescriptor(OnyxActivityViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 1,
		weight: 60,
		openCommandActionDescriptor: {
			id: 'onyx.openControlPlane',
			title: localize2('onyx.openControlPlane', "Open Onyx Control Plane"),
			keybindings: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyO },
			order: 2,
		},
	},
	{
		id: OnyxContextBudgetViewPane.ID,
		name: localize2('onyx.budget.name', "Context Budget"),
		containerIcon: onyxViewIcon,
		ctorDescriptor: new SyncDescriptor(OnyxContextBudgetViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 2,
		weight: 20,
	},
	{
		id: OnyxComputeViewPane.ID,
		name: localize2('onyx.compute.name', "Compute"),
		containerIcon: onyxViewIcon,
		ctorDescriptor: new SyncDescriptor(OnyxComputeViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		order: 3,
		weight: 20,
	},
	{
		id: OnyxInspectorViewPane.ID,
		name: localize2('onyx.inspector.name', "Inspector"),
		containerIcon: onyxViewIcon,
		ctorDescriptor: new SyncDescriptor(OnyxInspectorViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		collapsed: true,
		order: 4,
		weight: 30,
	},
], container);
