import angular from 'angular';
import * as _ from 'lodash-es';
import filesizeParser from 'filesize-parser';
import { KubernetesResourceQuota, KubernetesResourceQuotaDefaults } from 'Kubernetes/models/resource-quota/models';
import KubernetesResourceReservationHelper from 'Kubernetes/helpers/resourceReservationHelper';
import KubernetesEventHelper from 'Kubernetes/helpers/eventHelper';
import { KubernetesResourcePoolFormValues, KubernetesResourcePoolIngressClassAnnotationFormValue } from 'Kubernetes/models/resource-pool/formValues';
import { KubernetesIngressConverter } from 'Kubernetes/ingress/converter';
import { KubernetesFormValueDuplicate } from 'Kubernetes/models/application/formValues';
import KubernetesFormValidationHelper from 'Kubernetes/helpers/formValidationHelper';
import { KubernetesIngressClassTypes } from 'Kubernetes/ingress/constants';

class KubernetesResourcePoolController {
  /* #region  CONSTRUCTOR */
  /* @ngInject */
  constructor(
    $async,
    $state,
    Authentication,
    Notifications,
    LocalStorage,
    EndpointProvider,
    ModalService,
    KubernetesNodeService,
    KubernetesResourceQuotaService,
    KubernetesResourcePoolService,
    KubernetesEventService,
    KubernetesPodService,
    KubernetesApplicationService,
    KubernetesNamespaceHelper,
    KubernetesIngressService
  ) {
    this.$async = $async;
    this.$state = $state;
    this.Notifications = Notifications;
    this.Authentication = Authentication;
    this.LocalStorage = LocalStorage;
    this.EndpointProvider = EndpointProvider;
    this.ModalService = ModalService;

    this.KubernetesNodeService = KubernetesNodeService;
    this.KubernetesResourceQuotaService = KubernetesResourceQuotaService;
    this.KubernetesResourcePoolService = KubernetesResourcePoolService;
    this.KubernetesEventService = KubernetesEventService;
    this.KubernetesPodService = KubernetesPodService;
    this.KubernetesApplicationService = KubernetesApplicationService;
    this.KubernetesNamespaceHelper = KubernetesNamespaceHelper;
    this.KubernetesIngressService = KubernetesIngressService;

    this.IngressClassTypes = KubernetesIngressClassTypes;

    this.onInit = this.onInit.bind(this);
    this.createResourceQuotaAsync = this.createResourceQuotaAsync.bind(this);
    this.updateResourcePoolAsync = this.updateResourcePoolAsync.bind(this);
    this.getEvents = this.getEvents.bind(this);
    this.getEventsAsync = this.getEventsAsync.bind(this);
    this.getApplications = this.getApplications.bind(this);
    this.getApplicationsAsync = this.getApplicationsAsync.bind(this);
    this.getIngresses = this.getIngresses.bind(this);
    this.getIngressesAsync = this.getIngressesAsync.bind(this);
  }
  /* #endregion */

  onChangeIngressHostname() {
    const state = this.state.duplicates.ingressHosts;

    const hosts = _.map(this.formValues.IngressClasses, 'Host');
    const otherIngresses = _.without(this.allIngresses, ...this.ingresses);
    const allHosts = _.map(otherIngresses, 'Host');
    const duplicates = KubernetesFormValidationHelper.getDuplicates(hosts);
    _.forEach(hosts, (host, idx) => {
      if (_.includes(allHosts, host) && host !== undefined) {
        duplicates[idx] = host;
      }
    });
    state.refs = duplicates;
    state.hasDuplicates = Object.keys(duplicates).length > 0;
  }

  /* #region  ANNOTATIONS MANAGEMENT */
  addAnnotation(ingressClass) {
    ingressClass.Annotations.push(new KubernetesResourcePoolIngressClassAnnotationFormValue());
  }

  removeAnnotation(ingressClass, index) {
    ingressClass.Annotations.splice(index, 1);
  }
  /* #endregion */

  selectTab(index) {
    this.LocalStorage.storeActiveTab('resourcePool', index);
  }

  isUpdateButtonDisabled() {
    return this.state.actionInProgress || (this.formValues.HasQuota && !this.isQuotaValid()) || this.state.duplicates.ingressHosts.hasDuplicates;
  }

  isQuotaValid() {
    if (
      this.state.sliderMaxCpu < this.formValues.CpuLimit ||
      this.state.sliderMaxMemory < this.formValues.MemoryLimit ||
      (this.formValues.CpuLimit === 0 && this.formValues.MemoryLimit === 0)
    ) {
      return false;
    }
    return true;
  }

  checkDefaults() {
    if (this.formValues.CpuLimit < this.defaults.CpuLimit) {
      this.formValues.CpuLimit = this.defaults.CpuLimit;
    }
    if (this.formValues.MemoryLimit < KubernetesResourceReservationHelper.megaBytesValue(this.defaults.MemoryLimit)) {
      this.formValues.MemoryLimit = KubernetesResourceReservationHelper.megaBytesValue(this.defaults.MemoryLimit);
    }
  }

  showEditor() {
    this.state.showEditorTab = true;
    this.selectTab(2);
  }

  async createResourceQuotaAsync(namespace, owner, cpuLimit, memoryLimit) {
    const quota = new KubernetesResourceQuota(namespace);
    quota.CpuLimit = cpuLimit;
    quota.MemoryLimit = memoryLimit;
    quota.ResourcePoolName = namespace;
    quota.ResourcePoolOwner = owner;
    await this.KubernetesResourceQuotaService.create(quota);
  }

  hasResourceQuotaBeenReduced() {
    if (this.formValues.HasQuota && this.oldQuota) {
      const cpuLimit = this.formValues.CpuLimit;
      const memoryLimit = KubernetesResourceReservationHelper.bytesValue(this.formValues.MemoryLimit);
      if (cpuLimit < this.oldQuota.CpuLimit || memoryLimit < this.oldQuota.MemoryLimit) {
        return true;
      }
    }
    return false;
  }

  async updateResourcePoolAsync() {
    this.state.actionInProgress = true;
    try {
      this.checkDefaults();
      const namespace = this.pool.Namespace.Name;
      const cpuLimit = this.formValues.CpuLimit;
      const memoryLimit = KubernetesResourceReservationHelper.bytesValue(this.formValues.MemoryLimit);
      const owner = this.pool.Namespace.ResourcePoolOwner;
      const quota = this.pool.Quota;

      if (this.formValues.HasQuota) {
        if (quota) {
          quota.CpuLimit = cpuLimit;
          quota.MemoryLimit = memoryLimit;
          await this.KubernetesResourceQuotaService.update(quota);
        } else {
          await this.createResourceQuotaAsync(namespace, owner, cpuLimit, memoryLimit);
        }
      } else if (quota) {
        await this.KubernetesResourceQuotaService.delete(quota);
      }

      const promises = _.map(this.formValues.IngressClasses, (c) => {
        c.Namespace = namespace;
        if (c.WasSelected === false && c.Selected === true) {
          const ingress = KubernetesIngressConverter.resourcePoolIngressClassFormValueToIngress(c);
          return this.KubernetesIngressService.create(ingress);
        } else if (c.WasSelected === true && c.Selected === false) {
          return this.KubernetesIngressService.delete(c);
        } else if (c.WasSelected === true && c.Selected === true) {
          const oldIngress = _.find(this.ingresses, { Name: c.IngressClass.Name });
          const newIngress = KubernetesIngressConverter.resourcePoolIngressClassFormValueToIngress(c);
          newIngress.Paths = angular.copy(oldIngress.Paths);
          newIngress.PreviousHost = oldIngress.Host;
          return this.KubernetesIngressService.patch(oldIngress, newIngress);
        }
      });
      await Promise.all(promises);

      this.Notifications.success('Resource pool successfully updated', this.pool.Namespace.Name);
      this.$state.reload();
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to create resource pool');
    } finally {
      this.state.actionInProgress = false;
    }
  }

  updateResourcePool() {
    const willBeDeleted = _.filter(this.formValues.IngressClasses, { WasSelected: true, Selected: false });
    const warnings = {
      quota: this.hasResourceQuotaBeenReduced(),
      ingress: willBeDeleted.length !== 0,
    };

    if (warnings.quota || warnings.ingress) {
      const messages = {
        quota:
          'Reducing the quota assigned to an "in-use" resource pool may have unintended consequences, including preventing running applications from functioning correctly and potentially even blocking them from running at all.',
        ingress: 'Deactivating ingresses may cause applications to be unaccessible. All ingress configurations from affected applications will be removed.',
      };
      const displayedMessage = `${warnings.quota ? messages.quota : ''}${warnings.quota && warnings.ingress ? '<br/><br/>' : ''}
      ${warnings.ingress ? messages.ingress : ''}<br/><br/>Do you wish to continue?`;
      this.ModalService.confirmUpdate(displayedMessage, (confirmed) => {
        if (confirmed) {
          return this.$async(this.updateResourcePoolAsync);
        }
      });
    } else {
      return this.$async(this.updateResourcePoolAsync);
    }
  }

  hasEventWarnings() {
    return this.state.eventWarningCount;
  }

  /* #region  GET EVENTS */
  async getEventsAsync() {
    try {
      this.state.eventsLoading = true;
      this.events = await this.KubernetesEventService.get(this.pool.Namespace.Name);
      this.state.eventWarningCount = KubernetesEventHelper.warningCount(this.events);
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve resource pool related events');
    } finally {
      this.state.eventsLoading = false;
    }
  }

  getEvents() {
    return this.$async(this.getEventsAsync);
  }
  /* #endregion */

  /* #region  GET APPLICATIONS */
  async getApplicationsAsync() {
    try {
      this.state.applicationsLoading = true;
      this.applications = await this.KubernetesApplicationService.get(this.pool.Namespace.Name);
      this.applications = _.map(this.applications, (app) => {
        const resourceReservation = KubernetesResourceReservationHelper.computeResourceReservation(app.Pods);
        app.CPU = resourceReservation.CPU;
        app.Memory = resourceReservation.Memory;
        return app;
      });
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve applications.');
    } finally {
      this.state.applicationsLoading = false;
    }
  }

  getApplications() {
    return this.$async(this.getApplicationsAsync);
  }
  /* #endregion */

  /* #region  GET INGRESSES */
  async getIngressesAsync() {
    this.state.ingressesLoading = true;
    try {
      const namespace = this.pool.Namespace.Name;
      this.allIngresses = await this.KubernetesIngressService.get();
      this.ingresses = _.filter(this.allIngresses, { Namespace: namespace });
      _.forEach(this.ingresses, (ing) => {
        ing.Namespace = namespace;
        _.forEach(ing.Paths, (path) => {
          const application = _.find(this.applications, { ServiceName: path.ServiceName });
          path.ApplicationName = application && application.Name ? application.Name : '-';
        });
      });
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to retrieve ingresses.');
    } finally {
      this.state.ingressesLoading = false;
    }
  }

  getIngresses() {
    return this.$async(this.getIngressesAsync);
  }
  /* #endregion */

  /* #region  ON INIT */
  async onInit() {
    try {
      const endpoint = this.EndpointProvider.currentEndpoint();
      this.endpoint = endpoint;
      this.isAdmin = this.Authentication.isAdmin();
      this.defaults = KubernetesResourceQuotaDefaults;
      this.formValues = new KubernetesResourcePoolFormValues(this.defaults);
      this.formValues.HasQuota = false;

      this.state = {
        actionInProgress: false,
        sliderMaxMemory: 0,
        sliderMaxCpu: 0,
        cpuUsage: 0,
        cpuUsed: 0,
        memoryUsage: 0,
        memoryUsed: 0,
        activeTab: 0,
        currentName: this.$state.$current.name,
        showEditorTab: false,
        eventsLoading: true,
        applicationsLoading: true,
        ingressesLoading: true,
        viewReady: false,
        eventWarningCount: 0,
        canUseIngress: endpoint.Kubernetes.Configuration.IngressClasses.length,
        duplicates: {
          ingressHosts: new KubernetesFormValueDuplicate(),
        },
      };

      this.state.activeTab = this.LocalStorage.getActiveTab('resourcePool');

      const name = this.$transition$.params().id;

      const [nodes, pool] = await Promise.all([this.KubernetesNodeService.get(), this.KubernetesResourcePoolService.get(name)]);

      this.pool = pool;

      _.forEach(nodes, (item) => {
        this.state.sliderMaxMemory += filesizeParser(item.Memory);
        this.state.sliderMaxCpu += item.CPU;
      });
      this.state.sliderMaxMemory = KubernetesResourceReservationHelper.megaBytesValue(this.state.sliderMaxMemory);

      const quota = pool.Quota;
      if (quota) {
        this.oldQuota = angular.copy(quota);
        this.formValues.HasQuota = true;
        this.formValues.CpuLimit = quota.CpuLimit;
        this.formValues.MemoryLimit = KubernetesResourceReservationHelper.megaBytesValue(quota.MemoryLimit);

        this.state.cpuUsed = quota.CpuLimitUsed;
        this.state.memoryUsed = KubernetesResourceReservationHelper.megaBytesValue(quota.MemoryLimitUsed);
      }

      this.isEditable = !this.KubernetesNamespaceHelper.isSystemNamespace(this.pool.Namespace.Name);
      if (this.pool.Namespace.Name === 'default') {
        this.isEditable = false;
      }

      await this.getEvents();
      await this.getApplications();

      if (this.state.canUseIngress) {
        await this.getIngresses();
        const ingressClasses = endpoint.Kubernetes.Configuration.IngressClasses;
        this.formValues.IngressClasses = KubernetesIngressConverter.ingressClassesToFormValues(ingressClasses, this.ingresses);
      }
    } catch (err) {
      this.Notifications.error('Failure', err, 'Unable to load view data');
    } finally {
      this.state.viewReady = true;
    }
  }

  $onInit() {
    return this.$async(this.onInit);
  }
  /* #endregion */

  $onDestroy() {
    if (this.state.currentName !== this.$state.$current.name) {
      this.LocalStorage.storeActiveTab('resourcePool', 0);
    }
  }
}

export default KubernetesResourcePoolController;
angular.module('portainer.kubernetes').controller('KubernetesResourcePoolController', KubernetesResourcePoolController);
