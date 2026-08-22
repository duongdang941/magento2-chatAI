define([
    'jquery',
    'uiRegistry',
    'mage/translate'
], function ($, registry, $t) {
    'use strict';

    return function (config, element) {
        var $app = $(element);
        var saveUrl = $app.data('save-url');
        var fetchUrl = $app.data('fetch-url');
        var healthUrl = $app.data('health-url');
        var syncUrl = $app.data('sync-url');
        var formKey = $app.data('form-key');

        var $providerOverlay = $('#zcodeProviderOverlay');
        var $modelOverlay = $('#zcodeModelOverlay');
        var $providerForm = $('#zcodeProviderForm');
        var $modelSubForm = $('#zcodeModelSubForm');
        var $configuredModelsList = $('#zcodeConfiguredModelsList');
        var $hiddenModelsContainer = $('#zcodeHiddenModelsContainer');
        var $providerNotice = $('#zcodeProviderNotice');

        var currentModels = [];
        var noticeTimer = null;
        var editIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
        var deleteIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

        $providerNotice.on('click', '.zcode-provider-notice__close', function () {
            $providerNotice.stop(true, true).fadeOut(120);
        });

        function escapeHtml(value) {
            return $('<div>').text(String(value || '')).html();
        }

        function appendHiddenInput(name, value) {
            $('<input>', { type: 'hidden', name: name })
                .val(String(value))
                .appendTo($hiddenModelsContainer);
        }

        function getConfiguredMaxOutputTokens(model) {
            var raw = model && model.max_output_tokens;
            var hasValue = raw !== undefined && raw !== null && String(raw).trim() !== '';
            if (!hasValue) {
                return '';
            }

            var configured = Object.prototype.hasOwnProperty.call(model, 'max_output_tokens_configured')
                ? Boolean(model.max_output_tokens_configured)
                : Number(raw) !== 8192;
            return configured ? String(raw) : '';
        }

        function showNotice(message, type) {
            window.clearTimeout(noticeTimer);
            $providerNotice
                .stop(true, true)
                .removeClass('zcode-provider-notice--success zcode-provider-notice--error')
                .addClass(type === 'success'
                    ? 'zcode-provider-notice--success'
                    : 'zcode-provider-notice--error')
                .attr('role', type === 'success' ? 'status' : 'alert')
                .find('.zcode-provider-notice__message')
                .text(String(message || $t('The request could not be completed.')));
            $providerNotice.fadeIn(120);
            noticeTimer = window.setTimeout(function () {
                $providerNotice.fadeOut(180);
            }, type === 'success' ? 4000 : 7000);
        }

        function setBusy(isBusy) {
            $app.find('button').prop('disabled', Boolean(isBusy));
            $app.toggleClass('zcode-app-busy', Boolean(isBusy));
        }

        function renderModelsList() {
            $configuredModelsList.empty();
            $hiddenModelsContainer.empty();

            if (currentModels.length === 0) {
                $configuredModelsList.html('<div class="zcode-empty-models">' + $t('No models added yet.') + '</div>');
                return;
            }

            currentModels.forEach(function (m, idx) {
                var ctx = m.context_window || 200000;
                var formattedCtx = Number(ctx).toLocaleString();
                var maxOutValue = getConfiguredMaxOutputTokens(m);
                var maxOut = maxOutValue ? Number(maxOutValue).toLocaleString() : '';
                var imageTransport = m.image_transport || '';

                var cardHtml = '<div class="zcode-model-item" data-idx="' + idx + '">' +
                    '<div class="zcode-model-info">' +
                        '<span class="zcode-model-name font-mono">' + escapeHtml(m.id) + '</span>' +
                        '<span class="zcode-model-meta">' + $t('Context window: ') + formattedCtx + '</span>' +
                        (maxOut ? '<span class="zcode-model-meta badge-dim">' + $t('Max output: ') + maxOut + '</span>' : '') +
                    '</div>' +
                    '<div class="zcode-model-actions">' +
                        '<button type="button" class="zcode-icon-btn btn-edit-model" data-idx="' + idx + '" title="' + $t('Edit') + '" aria-label="' + $t('Edit') + '">' + editIcon + '</button>' +
                        '<button type="button" class="zcode-icon-btn zcode-icon-btn--danger btn-delete-model" data-idx="' + idx + '" title="' + $t('Delete') + '" aria-label="' + $t('Delete') + '">' + deleteIcon + '</button>' +
                    '</div>' +
                '</div>';

                $configuredModelsList.append(cardHtml);

                appendHiddenInput('models[' + idx + '][id]', m.id);
                appendHiddenInput('models[' + idx + '][context_window]', ctx);
                if (maxOutValue) {
                    appendHiddenInput('models[' + idx + '][max_output_tokens]', maxOutValue);
                }
                appendHiddenInput(
                    'models[' + idx + '][max_output_tokens_configured]',
                    maxOutValue ? 1 : 0
                );
                if (m.reasoning_enabled) {
                    appendHiddenInput('models[' + idx + '][reasoning_enabled]', 1);
                    (Array.isArray(m.reasoning_levels) ? m.reasoning_levels : []).forEach(function (level) {
                        appendHiddenInput('models[' + idx + '][reasoning_levels][]', level);
                    });
                    appendHiddenInput(
                        'models[' + idx + '][reasoning_default_level]',
                        m.reasoning_default_level || (Array.isArray(m.reasoning_levels) ? m.reasoning_levels[0] : '') || ''
                    );
                }
                if (m.supports_images) {
                    appendHiddenInput('models[' + idx + '][supports_images]', 1);
                    appendHiddenInput('models[' + idx + '][image_transport]', imageTransport);
                    if (m.image_model) {
                        appendHiddenInput('models[' + idx + '][image_model]', m.image_model);
                    }
                }
            });
        }

        function openProviderModal(isEdit) {
            $('#zcodeProviderModalTitle').text(isEdit ? $t('Edit model provider') : $t('Add model provider'));
            $('#zcodeProviderModalDesc').text(isEdit ? $t('Edit the custom API endpoint and model parameters.') : $t('Configure a custom API endpoint and initial model.'));
            $('#zcodeBtnSaveProviderText').text(isEdit ? $t('Save provider') : $t('Add provider'));
            $('#zcodeBtnSyncProvider').toggle(Boolean(isEdit && $('#zcodeFieldId').val()));

            // Reset API key input type to password and reset eye icon
            $('#zcodeFieldApiKey').attr('type', 'password');
            $('#zcodeToggleApiKeyVisibility .eye-open').show();
            $('#zcodeToggleApiKeyVisibility .eye-closed').hide();

            $providerOverlay.fadeIn(180);
            $('body').addClass('zcode-popup-open');
        }

        function closeProviderModal() {
            window.clearTimeout(noticeTimer);
            $providerNotice.stop(true, true).hide();
            setBusy(false);
            $providerOverlay.fadeOut(150);
            $('body').removeClass('zcode-popup-open');
            $providerForm[0].reset();
            $('#zcodeFieldId').val('');
            $('#zcodeBtnSyncProvider').hide().prop('disabled', false);
            currentModels = [];
            renderModelsList();
        }

        function openModelSubModal(editIdx) {
            $('#zcodeEditingModelIndex').val(editIdx !== undefined ? editIdx : -1);
            if (editIdx !== undefined && editIdx >= 0 && currentModels[editIdx]) {
                var m = currentModels[editIdx];
                $('#zcodeSubModalTitle').text($t('Edit model settings'));
                $('#zcodeSubModelId').val(m.id);
                $('#zcodeSubContextWindow').val(m.context_window || 200000);
                $('#zcodeSubMaxOutputTokens').val(getConfiguredMaxOutputTokens(m));
            } else {
                $('#zcodeSubModalTitle').text($t('Add model'));
                $('#zcodeSubModelId').val('');
                $('#zcodeSubContextWindow').val(200000);
                $('#zcodeSubMaxOutputTokens').val('');
            }
            $('#zcodeAdvancedContent').hide();
            $('#zcodeAdvancedChevron').removeClass('is-open');
            $modelOverlay.fadeIn(150);
        }

        function closeModelSubModal() {
            $modelOverlay.fadeOut(120);
            $modelSubForm[0].reset();
            $('#zcodeEditingModelIndex').val('-1');
        }

        // Global functions for Magento Grid
        window.openZCodeProviderModal = function () {
            closeProviderModal();
            currentModels = [];
            renderModelsList();
            openProviderModal(false);
        };

        window.openZCodeProviderEditModal = function (providerId) {
            $.ajax({
                url: fetchUrl,
                type: 'GET',
                dataType: 'json',
                data: { provider_id: providerId, form_key: formKey },
                showLoader: true,
                success: function (res) {
                    if (res.success && res.provider) {
                        var p = res.provider;
                        $('#zcodeFieldId').val(p.provider_id);
                        $('#zcodeFieldName').val(p.name);
                        $('#zcodeFieldBaseUrl').val(p.base_url);
                        $('#zcodeFieldApiKey').val(p.api_key || '');
                        $('#zcodeFieldApiFormat').val(p.api_format);
                        $('#zcodeFieldIsActive').prop('checked', parseInt(p.is_active, 10) === 1);

                        currentModels = (p.models && Array.isArray(p.models)) ? p.models : [];
                        renderModelsList();
                        openProviderModal(true);
                    } else {
                        showNotice(res.message || $t('Could not load provider data.'), 'error');
                    }
                },
                error: function (xhr) {
                    showNotice(xhr.responseJSON && xhr.responseJSON.message
                        ? xhr.responseJSON.message
                        : $t('Network error while loading provider data.'), 'error');
                }
            });
        };

        // Toggle API Key Visibility (Eye icon)
        $('#zcodeToggleApiKeyVisibility').on('click', function (e) {
            e.preventDefault();
            var $input = $('#zcodeFieldApiKey');
            var isPass = $input.attr('type') === 'password';
            $input.attr('type', isPass ? 'text' : 'password');
            $(this).find('.eye-open').toggle(!isPass);
            $(this).find('.eye-closed').toggle(isPass);
        });

        // Provider Modal Actions
        $('#zcodeCloseProviderModalBtn').on('click', closeProviderModal);
        $('#zcodeBtnCheckProvider').on('click', function () {
            var providerId = parseInt($('#zcodeFieldId').val(), 10) || 0;
            if (!providerId) {
                showNotice($t('Save the provider first, then test its connection.'), 'error');
                return;
            }

            var $button = $(this);
            setBusy(true);
            $button.text($t('Testing...'));
            $.ajax({
                url: healthUrl,
                type: 'POST',
                dataType: 'json',
                data: { provider_id: providerId, form_key: formKey },
                success: function (result) {
                    var message = result.message || $t('Provider health check completed.');
                    if (result.latency_ms) message += ' ' + $t('Latency: ') + result.latency_ms + ' ms.';
                    showNotice(message, result.success ? 'success' : 'error');
                },
                error: function () {
                    showNotice($t('The provider health check could not be completed.'), 'error');
                },
                complete: function () {
                    $button.text($t('Test connection'));
                    setBusy(false);
                }
            });
        });

        $('#zcodeBtnSyncProvider').on('click', function () {
            var providerId = parseInt($('#zcodeFieldId').val(), 10) || 0;
            if (!providerId) {
                showNotice($t('Save the provider first, then synchronize it to Node.'), 'error');
                return;
            }

            var $button = $(this);
            setBusy(true);
            $button.addClass('is-loading');
            $.ajax({
                url: syncUrl,
                type: 'POST',
                dataType: 'json',
                data: { provider_id: providerId, form_key: formKey },
                success: function (result) {
                    showNotice(result.message || $t('Provider synchronized to Node.'), result.success ? 'success' : 'error');
                },
                error: function (xhr) {
                    var message = xhr.responseJSON && xhr.responseJSON.message
                        ? xhr.responseJSON.message
                        : $t('The provider could not be synchronized to Node.');
                    showNotice(message, 'error');
                },
                complete: function () {
                    $button.removeClass('is-loading');
                    setBusy(false);
                }
            });
        });
        $providerOverlay.on('click', function (e) {
            if ($(e.target).is($providerOverlay)) {
                closeProviderModal();
            }
        });

        // Open Sub-Modal to Add Model
        $('#zcodeBtnOpenAddModel').on('click', function () {
            openModelSubModal(-1);
        });

        // Edit Model in List
        $configuredModelsList.on('click', '.btn-edit-model', function () {
            var idx = parseInt($(this).data('idx'), 10);
            openModelSubModal(idx);
        });

        // Delete Model from List
        $configuredModelsList.on('click', '.btn-delete-model', function () {
            var idx = parseInt($(this).data('idx'), 10);
            if (idx >= 0 && idx < currentModels.length) {
                currentModels.splice(idx, 1);
                renderModelsList();
            }
        });

        // Sub-Modal Actions
        $('#zcodeCloseModelBtn').on('click', closeModelSubModal);
        $modelOverlay.on('click', function (e) {
            if ($(e.target).is($modelOverlay)) {
                closeModelSubModal();
            }
        });

        // Advanced section toggle (chevron)
        $('#zcodeAdvancedToggle').on('click', function (e) {
            e.preventDefault();
            var $content = $('#zcodeAdvancedContent');
            var $chevron = $('#zcodeAdvancedChevron');
            $content.slideToggle(120, function () {
                $chevron.toggleClass('is-open', $content.is(':visible'));
            });
        });

        // Save Model Sub-Form
        $modelSubForm.on('submit', function (e) {
            e.preventDefault();
            var mId = $.trim($('#zcodeSubModelId').val());
            if (!mId) return;

            var ctx = parseInt($('#zcodeSubContextWindow').val(), 10) || 200000;
            var maxOut = $.trim($('#zcodeSubMaxOutputTokens').val());
            var editIdx = parseInt($('#zcodeEditingModelIndex').val(), 10);
            var previousModel = editIdx >= 0 && editIdx < currentModels.length ? currentModels[editIdx] : {};

            var modelObj = {
                id: mId,
                context_window: ctx,
                max_output_tokens: maxOut ? parseInt(maxOut, 10) : '',
                max_output_tokens_configured: Boolean(maxOut),
                // Thought-level capability is consumed from Magento AI Config;
                // preserve existing metadata for already-registered models.
                reasoning_enabled: Boolean(previousModel.reasoning_enabled),
                reasoning_levels: Array.isArray(previousModel.reasoning_levels) ? previousModel.reasoning_levels : [],
                reasoning_default_level: previousModel.reasoning_default_level || '',
                // Image capability is configured in AI Configuration; retain
                // legacy model metadata while providers are migrated.
                supports_images: Boolean(previousModel.supports_images),
                image_transport: previousModel.image_transport || '',
                image_model: previousModel.image_model || ''
            };

            if (editIdx >= 0 && editIdx < currentModels.length) {
                currentModels[editIdx] = modelObj;
            } else {
                currentModels.push(modelObj);
            }

            renderModelsList();
            closeModelSubModal();
        });

        // Provider Form Submit
        $providerForm.on('submit', function (e) {
            e.preventDefault();
            var $btn = $('#zcodeBtnSaveProvider');
            var $spinner = $btn.find('.zcode-spinner');

            setBusy(true);
            $spinner.show();

            var formData = $providerForm.serialize();

            $.ajax({
                url: saveUrl,
                type: 'POST',
                dataType: 'json',
                data: formData,
                success: function (res) {
                    if (res.success) {
                        if (res.provider && res.provider.provider_id) {
                            $('#zcodeFieldId').val(res.provider.provider_id);
                        }
                        openProviderModal(true);
                        showNotice(res.message || $t('Provider saved successfully.'), 'success');
                        var gridSource = registry.get('afd_ai_provider_listing.afd_ai_provider_listing_data_source');
                        if (gridSource && typeof gridSource.reload === 'function') {
                            gridSource.reload({ refresh: true });
                        } else {
                            location.reload();
                        }
                    } else {
                        showNotice(res.message || $t('Could not save provider.'), 'error');
                    }
                },
                error: function (xhr) {
                    var msg = $t('Network error while saving provider.');
                    try {
                        var parsed = JSON.parse(xhr.responseText);
                        if (parsed && parsed.message) {
                            msg = parsed.message;
                        }
                    } catch(e) {}
                    showNotice(msg, 'error');
                },
                complete: function () {
                    $spinner.hide();
                    setBusy(false);
                }
            });
        });
    };
});
